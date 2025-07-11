import { IAkariShardInitDispose, Shard } from '@shared/akari-shard'
import dayjs from 'dayjs'
import { app } from 'electron'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DataSource, QueryRunner } from 'typeorm'

import { AkariLogger, LoggerFactoryMain } from '../logger-factory'
import { EncounteredGame } from './entities/EncounteredGame'
import { Metadata } from './entities/Metadata'
import { SavedPlayer } from './entities/SavedPlayers'
import { Setting } from './entities/Settings'
import { v10_LA1_2_0initializationUpgrade } from './upgrades/version-10'
import { v15_LA1_2_2Upgrade } from './upgrades/version-15'

/**
 * 任何持久性存储的逻辑集成
 */
@Shard(StorageMain.id)
export class StorageMain implements IAkariShardInitDispose {
  static id = 'storage-main'

  static LEAGUE_AKARI_DB_CURRENT_VERSION = 15
  static LEAGUE_AKARI_DB_FILENAME = 'LeagueAkari.db'

  private readonly _log: AkariLogger

  private readonly _dataSource: DataSource

  private readonly _upgrades = {
    10: v10_LA1_2_0initializationUpgrade,
    15: v15_LA1_2_2Upgrade
  }

  get dataSource() {
    return this._dataSource
  }

  constructor(private readonly _loggerFactory: LoggerFactoryMain) {
    this._log = _loggerFactory.create(StorageMain.id)

    this._dataSource = new DataSource({
      type: 'sqlite',
      database: join(app.getPath('userData'), StorageMain.LEAGUE_AKARI_DB_FILENAME),
      synchronize: false,
      entities: [Metadata, SavedPlayer, Setting, EncounteredGame]
    })
  }

  async onInit() {
    await this._checkAndInitializeDatabase(this._dataSource)
  }

  async onDispose() {
    await this._dataSource.destroy()
  }

  private async _checkAndInitializeDatabase(dataSource: DataSource) {
    await this._initializeDatabase(dataSource)
    const dbPath = dataSource.options.database as string
    if (!dbPath) {
      return
    }

    this._log.info(`Current database file located at ${dbPath}`)

    const { needToRecreateDatabase, needToPerformUpgrade, currentVersion } =
      await this._checkDatabaseVersion(dataSource)

    this._log.info(`Current version ${currentVersion}`)

    let cv = currentVersion

    if (!needToPerformUpgrade && !needToPerformUpgrade) {
      this._log.info(`Current version database does not need to be migrated`)
    }

    if (needToRecreateDatabase) {
      this._log.warn(`Invalid database format, need to recreate database`)
      await this._recreateDatabase(dataSource, dbPath)
      cv = 0
    }

    if (needToPerformUpgrade) {
      this._log.info(`Database needs to be upgraded from ${cv} version`)
      const queryRunner = dataSource.createQueryRunner()
      await queryRunner.startTransaction()

      try {
        await this._performUpgrades(queryRunner, cv)

        await queryRunner.commitTransaction()
      } catch (error) {
        await queryRunner.rollbackTransaction()
        throw error
      } finally {
        await queryRunner.release()
      }
    }
  }

  /**
   * 处理 League Akari 的数据库的升级
   */
  private async _performUpgrades(r: QueryRunner, currentVersion: number) {
    const pendingUpgrades = Object.entries(this._upgrades)
      .filter(([v]) => Number(v) > currentVersion)
      .toSorted(([v1], [v2]) => Number(v1) - Number(v2))

    this._log.info(`Number of database upgrades to be performed: ${pendingUpgrades.length}`)

    for (const [v, fn] of pendingUpgrades) {
      this._log.info(`Executing => version ${v} migration`)
      await fn(r)
    }

    this._log.info(`All database migrations completed`)
  }

  private async _initializeDatabase(dataSource: DataSource) {
    await dataSource.initialize()
  }

  private async _recreateDatabase(dataSource: DataSource, dbPath: string) {
    await dataSource.destroy()

    if (existsSync(dbPath)) {
      const backupPath = join(dbPath, `../${dayjs().format('YYYYMMDDHHmmssSSS')}_bk.db`)

      renameSync(dbPath, backupPath)
      this._log.info(`Original database cannot be used, backed up to ${backupPath}`)
    }

    await dataSource.initialize()
  }

  private async _checkDatabaseVersion(dataSource: DataSource): Promise<{
    needToRecreateDatabase: boolean
    needToPerformUpgrade: boolean
    currentVersion: number
  }> {
    const queryRunner = dataSource.createQueryRunner()
    let needToRecreateDatabase = false
    let needToPerformUpgrade = false
    let currentVersion = 0

    try {
      const metadataTable = await queryRunner.getTable('Metadata')
      if (metadataTable) {
        const versionResult = await queryRunner.manager.query(
          "SELECT value FROM Metadata WHERE key = 'version'"
        )
        if (versionResult.length) {
          currentVersion = parseInt(versionResult[0].value, 10)
          if (currentVersion > StorageMain.LEAGUE_AKARI_DB_CURRENT_VERSION) {
            // version is too high and needs recreation
            needToRecreateDatabase = true
            needToPerformUpgrade = true
          } else if (currentVersion < StorageMain.LEAGUE_AKARI_DB_CURRENT_VERSION) {
            // low version, need to upgrade
            needToPerformUpgrade = true
          }
        } else {
          // no version field, malformed db
          needToRecreateDatabase = true
          needToPerformUpgrade = true
        }
      } else {
        // just created, need to build the db
        needToPerformUpgrade = true
      }
    } finally {
      await queryRunner.release()
    }

    return { needToRecreateDatabase, needToPerformUpgrade, currentVersion }
  }
}
