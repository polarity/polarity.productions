#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { pipeline } = require('stream/promises')
const { Readable } = require('stream')
const { Client } = require('ssh2')

const ROOT = path.resolve(__dirname, '..')
const GITHUB_ROOT = path.resolve(ROOT, '..')
const BUILD_DIR = path.join(ROOT, '.buildt')
const CONFIG_PATH = path.join(BUILD_DIR, 'uberspace-config.json')
const SFTP_CONFIG_PATH = path.join(BUILD_DIR, 'sftp-config.json')
const DEFAULT_SQL_EXPORT = path.join(BUILD_DIR, 'dispenser-db-export.sql')
const DISPENSER_ROOT = path.join(GITHUB_ROOT, 'app.dispenser', 'dispenser')
const DISPENSER_CONFIG_PATH = path.join(DISPENSER_ROOT, 'config.php')
const DISPENSER_UPLOADS_PATH = path.join(DISPENSER_ROOT, 'uploads')

const argv = process.argv.slice(2)
const action = argv.find((arg) => !arg.startsWith('--')) || 'check'
const isDryRun = argv.includes('--dry-run')

function formatError (err) {
  return err?.message || String(err)
}

function loadJson (filePath, fallback = {}) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function optionValue (name, fallback = '') {
  const prefix = `${name}=`
  const match = argv.find((arg) => arg.startsWith(prefix))
  return match ? match.slice(prefix.length) : fallback
}

function expandHomePath (filePath) {
  const input = String(filePath || '')
  if (!input.startsWith('~')) return input
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (!home) return input
  if (input === '~') return home
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(home, input.slice(2))
  }
  return input
}

function shellQuote (value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function phpString (value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function normalizeRemotePath (remotePath) {
  const normalized = path.posix.normalize(String(remotePath || '').replace(/\\/g, '/'))
  return (!normalized || normalized === '.') ? '' : normalized
}

function loadMigrationConfig () {
  const migrationConfig = loadJson(CONFIG_PATH, {})
  const sftpConfig = loadJson(SFTP_CONFIG_PATH, {})
  const username = process.env.UBERSPACE_USERNAME || migrationConfig.username || sftpConfig.username || 'poliprod'
  const config = {
    host: process.env.UBERSPACE_HOST || migrationConfig.host || sftpConfig.host || 'adhara.uberspace.de',
    port: parseInt(String(process.env.UBERSPACE_PORT || migrationConfig.port || sftpConfig.port || '22'), 10),
    username,
    password: process.env.UBERSPACE_PASSWORD || migrationConfig.password || sftpConfig.password || '',
    privateKey: process.env.UBERSPACE_PRIVATE_KEY || migrationConfig.privateKey || sftpConfig.privateKey || '',
    privateKeyPath: process.env.UBERSPACE_PRIVATE_KEY_PATH || migrationConfig.privateKeyPath || sftpConfig.privateKeyPath || '~/.ssh/id_ed25519',
    passphrase: process.env.UBERSPACE_PASSPHRASE || migrationConfig.passphrase || sftpConfig.passphrase || '',
    agent: process.env.UBERSPACE_AGENT || migrationConfig.agent || sftpConfig.agent || '',
    phpVersion: String(process.env.UBERSPACE_PHP_VERSION || migrationConfig.phpVersion || '8.5'),
    remoteWebroot: normalizeRemotePath(migrationConfig.remoteWebroot || `/var/www/virtual/${username}/html`),
    dispenserDatabase: process.env.DISPENSER_DATABASE || migrationConfig.dispenserDatabase || `${username}_dispenser`,
    shortlinkApiToken: process.env.SHORTLINK_API_TOKEN || migrationConfig.shortlinkApiToken || '',
    domains: Array.isArray(migrationConfig.domains) ? migrationConfig.domains : ['polarity.productions']
  }

  if (config.privateKey) {
    config.privateKey = String(config.privateKey).replace(/\\n/g, '\n')
  } else if (config.privateKeyPath) {
    const privateKeyPath = expandHomePath(config.privateKeyPath)
    if (!fs.existsSync(privateKeyPath)) {
      if (!isDryRun) throw new Error(`privateKeyPath does not exist: ${privateKeyPath}`)
      config.privateKey = ''
    } else {
      config.privateKey = fs.readFileSync(privateKeyPath, 'utf8')
    }
  }

  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error('UBERSPACE_PORT must be a positive integer.')
  }
  if (!isDryRun && !config.password && !config.privateKey && !config.agent) {
    throw new Error(`Missing SSH authentication. Create ${path.relative(ROOT, CONFIG_PATH)} or ${path.relative(ROOT, SFTP_CONFIG_PATH)}.`)
  }
  return config
}

function connectSsh (config) {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    const finish = (err) => {
      if (settled) return
      settled = true
      if (err) {
        try { client.end() } catch {}
        reject(err)
      } else {
        resolve(client)
      }
    }

    client.on('ready', () => finish())
    client.on('error', finish)
    client.on('close', () => {
      if (!settled) finish(new Error('SSH connection closed before ready.'))
    })
    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: 30000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 6,
      ...(config.agent ? { agent: config.agent } : {}),
      ...(config.password ? { password: config.password } : {}),
      ...(config.privateKey ? { privateKey: config.privateKey } : {}),
      ...(config.passphrase ? { passphrase: config.passphrase } : {})
    })
  })
}

function execRemote (client, command, options = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      stream.on('data', (chunk) => { stdout += chunk.toString('utf8') })
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      stream.on('close', (code) => {
        if (code && !options.allowFailure) {
          reject(new Error(`Remote command failed (${code}): ${command}\n${stderr || stdout}`))
          return
        }
        resolve({ code, stdout, stderr })
      })
    })
  })
}

function openSftp (client) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(err)
      else resolve(sftp)
    })
  })
}

async function uploadString (client, remotePath, contents) {
  const sftp = await openSftp(client)
  await pipeline(Readable.from([contents]), sftp.createWriteStream(remotePath))
}

async function uploadFile (client, localPath, remotePath) {
  const sftp = await openSftp(client)
  await pipeline(fs.createReadStream(localPath), sftp.createWriteStream(remotePath))
}

function sftpStat (sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) reject(err)
      else resolve(stats)
    })
  })
}

function sftpMkdir (sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function ensureRemoteDir (sftp, remoteDir, cache = new Set()) {
  const normalized = normalizeRemotePath(remoteDir)
  if (!normalized || normalized === '/') return
  const parts = normalized.split('/').filter(Boolean)
  let current = normalized.startsWith('/') ? '/' : ''
  for (const part of parts) {
    current = current === '/' ? `/${part}` : (current ? `${current}/${part}` : part)
    if (cache.has(current)) continue
    try {
      await sftpStat(sftp, current)
    } catch {
      await sftpMkdir(sftp, current)
    }
    cache.add(current)
  }
}

function walkFiles (dirPath) {
  if (!fs.existsSync(dirPath)) return []
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(fullPath))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

async function remoteMysqlPassword (client) {
  const result = await execRemote(client, "my_print_defaults client | sed -n 's/^--password=//p' | head -n 1")
  const password = result.stdout.trim()
  if (!password) throw new Error('Could not read MySQL password through my_print_defaults client.')
  return password
}

function renderDispenserConfig (config, mysqlPassword) {
  if (!fs.existsSync(DISPENSER_CONFIG_PATH)) {
    throw new Error(`Missing local Dispenser config: ${DISPENSER_CONFIG_PATH}`)
  }
  const encoded = execFileSync('php', [
    '-r',
    `$config = require ${phpString(DISPENSER_CONFIG_PATH)}; echo json_encode($config, JSON_THROW_ON_ERROR);`
  ], { encoding: 'utf8' })
  const local = JSON.parse(encoded)
  local.debug = false
  local.db = {
    host: 'localhost',
    port: 3306,
    database: config.dispenserDatabase,
    user: config.username,
    password: mysqlPassword
  }
  local.shortener = {
    enabled: true,
    mode: 'api',
    base_url: 'https://polarity.me/go.php?c=',
    api_url: 'https://polarity.me/shortlink-api.php',
    api_token: config.shortlinkApiToken || 'SHORTLINK_API_TOKEN_NOT_CONFIGURED'
  }
  local.patreon = {
    ...(local.patreon || {}),
    redirect_uri: 'https://polarity.productions/dispenser/callback.php'
  }
  local.google = {
    ...(local.google || {}),
    redirect_uri: 'https://polarity.productions/dispenser/callback_google.php'
  }

  return `<?php
// Generated by scripts/uberspace-migrate.js for Uberspace.
return ${renderPhpValue(local, 0)};
`
}

function renderPhpValue (value, depth) {
  const indent = '  '.repeat(depth)
  const nextIndent = '  '.repeat(depth + 1)
  if (Array.isArray(value)) {
    return '[\n' + value.map((item) => `${nextIndent}${renderPhpValue(item, depth + 1)}`).join(",\n") + `\n${indent}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => {
      return `${nextIndent}${phpString(key)} => ${renderPhpValue(item, depth + 1)}`
    })
    return '[\n' + entries.join(",\n") + `\n${indent}]`
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (value === null) return 'null'
  return phpString(value)
}

async function runCheck (client, config) {
  const commands = [
    'printf "user=%s\\nhome=%s\\n" "$USER" "$HOME"',
    `test -d ${shellQuote(config.remoteWebroot)} && printf "webroot=ok\\n" || printf "webroot=missing\\n"`,
    'php -v | head -n 1',
    'php -m | grep -E "^(curl|gd|imagick|mbstring|openssl|PDO|pdo_mysql)$" | sort',
    'mysql --batch --skip-column-names -e "SELECT VERSION();"'
  ]
  for (const command of commands) {
    const result = await execRemote(client, command, { allowFailure: true })
    process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
}

async function runSetup (client, config) {
  const commands = [
    `mkdir -p ${shellQuote(config.remoteWebroot)}`,
    `rm -f ${shellQuote(path.posix.join(config.remoteWebroot, 'nocontent.html'))}`,
    `uberspace tools version use php ${shellQuote(config.phpVersion)}`,
    `mysql -e ${shellQuote(`CREATE DATABASE IF NOT EXISTS \`${config.dispenserDatabase.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`)}`,
    ...config.domains.map((domain) => {
      return `uberspace web domain list | grep -qx ${shellQuote(domain)} || uberspace web domain add ${shellQuote(domain)}`
    })
  ]
  for (const command of commands) {
    console.log(isDryRun ? `[dry-run] ${command}` : command)
    if (!isDryRun) await execRemote(client, command)
  }
}

async function runDispenserConfig (client, config) {
  if (!isDryRun && !config.shortlinkApiToken) {
    throw new Error('Missing shortlinkApiToken in .buildt/uberspace-config.json or SHORTLINK_API_TOKEN env var.')
  }
  const password = isDryRun ? 'MYSQL_PASSWORD_FROM_UBERSPACE_MY_CNF' : await remoteMysqlPassword(client)
  const remotePath = path.posix.join(config.remoteWebroot, 'dispenser', 'config.php')
  const contents = renderDispenserConfig(config, password)
  console.log(`${isDryRun ? '[dry-run] would upload' : 'upload'} ${remotePath}`)
  if (!isDryRun) {
    await execRemote(client, `mkdir -p ${shellQuote(path.posix.dirname(remotePath))}`)
    await uploadString(client, remotePath, contents)
    await execRemote(client, `chmod 640 ${shellQuote(remotePath)}`)
  }
}

async function runUploads (client, config) {
  if (!fs.existsSync(DISPENSER_UPLOADS_PATH)) {
    console.log(`No local uploads directory found: ${DISPENSER_UPLOADS_PATH}`)
    return
  }
  const files = walkFiles(DISPENSER_UPLOADS_PATH)
  const remoteRoot = path.posix.join(config.remoteWebroot, 'dispenser', 'uploads')
  console.log(`${isDryRun ? '[dry-run] would upload' : 'upload'} ${files.length} upload files to ${remoteRoot}`)
  if (isDryRun) {
    for (const filePath of files) {
      console.log(`  ${path.relative(DISPENSER_UPLOADS_PATH, filePath).split(path.sep).join('/')}`)
    }
    return
  }

  const sftp = await openSftp(client)
  const ensuredDirs = new Set()
  for (const filePath of files) {
    const relativePath = path.relative(DISPENSER_UPLOADS_PATH, filePath).split(path.sep).join('/')
    const remotePath = path.posix.join(remoteRoot, relativePath)
    await ensureRemoteDir(sftp, path.posix.dirname(remotePath), ensuredDirs)
    console.log(`upload uploads/${relativePath}`)
    await uploadFile(client, filePath, remotePath)
  }
}

async function runImportDb (client, config) {
  const sqlPath = optionValue('--sql', DEFAULT_SQL_EXPORT)
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`Missing SQL export: ${sqlPath}. Run npm run uberspace:db:export first.`)
  }
  const remoteSqlPath = `/home/${config.username}/tmp/dispenser-import.sql`
  console.log(`${isDryRun ? '[dry-run] would import' : 'import'} ${sqlPath} into ${config.dispenserDatabase}`)
  if (isDryRun) return
  await execRemote(client, `mkdir -p ${shellQuote(path.posix.dirname(remoteSqlPath))}`)
  await uploadFile(client, sqlPath, remoteSqlPath)
  await execRemote(client, `mysql ${shellQuote(config.dispenserDatabase)} < ${shellQuote(remoteSqlPath)}`)
  await execRemote(client, `rm -f ${shellQuote(remoteSqlPath)}`, { allowFailure: true })
}

async function runDbCounts (client, config) {
  const tablesResult = await execRemote(client, `mysql --batch --skip-column-names ${shellQuote(config.dispenserDatabase)} -e 'SHOW TABLES'`)
  const tables = tablesResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))

  for (const table of tables) {
    const safeTable = table.replace(/`/g, '``')
    const result = await execRemote(client, `mysql --batch --skip-column-names ${shellQuote(config.dispenserDatabase)} -e ${shellQuote(`SELECT COUNT(*) FROM \`${safeTable}\``)}`)
    console.log(`${table}: ${result.stdout.trim()}`)
  }
}

async function runPermissions (client, config) {
  const commands = [
    `chmod -R u=rwX,go=rX ${shellQuote(config.remoteWebroot)}`,
    `chmod -R u=rwX,go=rX ${shellQuote(path.posix.join(config.remoteWebroot, 'dispenser', 'uploads'))} 2>/dev/null || true`,
    `restorecon -R -v ${shellQuote(config.remoteWebroot)} >/dev/null 2>&1 || true`
  ]
  for (const command of commands) {
    console.log(isDryRun ? `[dry-run] ${command}` : command)
    if (!isDryRun) await execRemote(client, command)
  }
}

async function withRemote (config, fn) {
  if (isDryRun && ['setup', 'dispenser:config', 'dispenser:uploads', 'db:import', 'permissions'].includes(action)) {
    await fn(null)
    return
  }
  const client = await connectSsh(config)
  try {
    await fn(client)
  } finally {
    client.end()
  }
}

async function main () {
  const config = loadMigrationConfig()
  await withRemote(config, async (client) => {
    if (action === 'check') return runCheck(client, config)
    if (action === 'setup') return runSetup(client, config)
    if (action === 'dispenser:config') return runDispenserConfig(client, config)
    if (action === 'dispenser:uploads') return runUploads(client, config)
    if (action === 'db:import') return runImportDb(client, config)
    if (action === 'db:counts') return runDbCounts(client, config)
    if (action === 'permissions') return runPermissions(client, config)
    throw new Error(`Unknown action "${action}".`)
  })
}

main().catch((err) => {
  console.error(formatError(err))
  process.exit(1)
})
