#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { pipeline } = require('stream/promises')
const { Client } = require('ssh2')

const ROOT = path.resolve(__dirname, '..')
const PUBLIC_DIR = path.join(ROOT, 'public')
const BUILD_DIR = path.join(ROOT, '.buildt')
const SFTP_CONFIG_PATH = path.join(BUILD_DIR, 'sftp-config.json')
const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')
const deployScope = args.includes('--all') ? 'all' : 'root'
const MANIFEST_PATH = path.join(
  BUILD_DIR,
  deployScope === 'all' ? 'sftp-deploy-manifest.json' : 'sftp-deploy-manifest-root.json'
)

function formatError (err) {
  return err?.message || String(err)
}

function loadJson (filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function saveJson (filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function normalizeRelativePath (relativePath) {
  return String(relativePath || '').split(path.sep).join('/')
}

function sanitizeRemotePath (remotePath) {
  const normalized = path.posix.normalize(String(remotePath || '').replace(/\\/g, '/'))
  return (!normalized || normalized === '.') ? '' : normalized
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

function loadPrivateKey (config) {
  const inlineKey = config.privateKey ? String(config.privateKey).replace(/\\n/g, '\n') : ''
  if (inlineKey) return inlineKey

  const privateKeyPath = config.privateKeyPath ? expandHomePath(config.privateKeyPath) : ''
  if (!privateKeyPath) return ''
  if (!fs.existsSync(privateKeyPath)) {
    if (isDryRun) return ''
    throw new Error(`SFTP privateKeyPath does not exist: ${privateKeyPath}`)
  }
  return fs.readFileSync(privateKeyPath, 'utf8')
}

function validateConfig () {
  const fileConfig = loadJson(SFTP_CONFIG_PATH, {})
  const config = {
    host: process.env.SFTP_HOST || fileConfig.host || 'adhara.uberspace.de',
    port: parseInt(String(process.env.SFTP_PORT || fileConfig.port || '22'), 10),
    username: process.env.SFTP_USERNAME || fileConfig.username || 'poliprod',
    password: process.env.SFTP_PASSWORD || fileConfig.password || '',
    privateKey: process.env.SFTP_PRIVATE_KEY || fileConfig.privateKey || '',
    privateKeyPath: process.env.SFTP_PRIVATE_KEY_PATH || fileConfig.privateKeyPath || '~/.ssh/id_ed25519',
    passphrase: process.env.SFTP_PASSPHRASE || fileConfig.passphrase || '',
    agent: process.env.SFTP_AGENT || fileConfig.agent || '',
    remotePath: sanitizeRemotePath(process.env.SFTP_REMOTE_PATH || fileConfig.remotePath || '/var/www/virtual/poliprod/html')
  }
  config.privateKey = loadPrivateKey(config)

  const missing = []
  if (!config.host) missing.push('host')
  if (!config.username) missing.push('username')
  if (!config.remotePath) missing.push('remotePath')
  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error('SFTP_PORT must be a positive integer.')
  }
  if (missing.length) {
    throw new Error(`Missing SFTP config: ${missing.join(', ')}.`)
  }
  if (!isDryRun && !config.password && !config.privateKey && !config.agent) {
    throw new Error(`Missing SFTP authentication. Create ${path.relative(ROOT, SFTP_CONFIG_PATH)} or set SFTP_* env vars.`)
  }

  return config
}

function walkFiles (dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
  const files = []

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath))
    } else if (entry.isFile()) {
      files.push(fullPath)
    }
  }

  return files
}

function isInDeployScope (relativePath) {
  if (deployScope === 'all') return true
  return relativePath === 'index.html' || relativePath.startsWith('assets/')
}

function hashFile (filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function buildManifest () {
  if (!fs.existsSync(PUBLIC_DIR)) {
    throw new Error('Missing public/ directory. Run "npm run assemble" first.')
  }

  const manifest = {}
  for (const filePath of walkFiles(PUBLIC_DIR)) {
    const relativePath = normalizeRelativePath(path.relative(PUBLIC_DIR, filePath))
    if (!isInDeployScope(relativePath)) {
      continue
    }
    const stats = fs.statSync(filePath)
    manifest[relativePath] = {
      path: relativePath,
      sha256: await hashFile(filePath),
      size: stats.size
    }
  }
  return sortManifest(manifest)
}

function sortManifest (manifest) {
  return Object.fromEntries(
    Object.keys(manifest)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [key, manifest[key]])
  )
}

function loadManifest () {
  const raw = loadJson(MANIFEST_PATH, {})
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

function saveManifest (manifest) {
  saveJson(MANIFEST_PATH, sortManifest(manifest))
}

function diffManifest (previousManifest, currentManifest) {
  const uploads = []
  const deletes = []

  for (const relativePath of Object.keys(currentManifest)) {
    const previous = previousManifest[relativePath]
    const current = currentManifest[relativePath]
    if (!previous || previous.sha256 !== current.sha256 || previous.size !== current.size) {
      uploads.push(relativePath)
    }
  }

  for (const relativePath of Object.keys(previousManifest).sort((a, b) => a.localeCompare(b))) {
    if (!currentManifest[relativePath]) {
      deletes.push(relativePath)
    }
  }

  return { uploads, deletes }
}

function connectSftp (config) {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    const finish = (err, result) => {
      if (settled) return
      settled = true
      if (err) {
        try { client.end() } catch {}
        reject(err)
      } else {
        resolve(result)
      }
    }

    client.on('ready', () => {
      client.sftp((err, sftp) => finish(err, { client, sftp }))
    })
    client.on('error', (err) => finish(err))
    client.on('close', () => {
      if (!settled) finish(new Error('SFTP connection closed before ready.'))
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

function sftpUnlink (sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function sftpPut (sftp, localPath, remotePath) {
  await pipeline(fs.createReadStream(localPath), sftp.createWriteStream(remotePath))
}

function isNotFoundError (err) {
  const message = String(err?.message || '')
  return err?.code === 2 || err?.code === 'ENOENT' || /no such file/i.test(message)
}

function isDirectoryStat (stats) {
  if (!stats) return false
  if (typeof stats.isDirectory === 'function') return stats.isDirectory()
  return (stats.mode & fs.constants.S_IFMT) === fs.constants.S_IFDIR
}

async function ensureRemoteDir (sftp, remoteDir, cache) {
  const normalized = path.posix.normalize(remoteDir)
  if (!normalized || normalized === '.' || normalized === '/') return

  const parts = normalized.split('/').filter(Boolean)
  let current = normalized.startsWith('/') ? '/' : ''
  for (const part of parts) {
    current = current === '/' ? `/${part}` : (current ? `${current}/${part}` : part)
    if (cache.has(current)) continue

    let stats = null
    try {
      stats = await sftpStat(sftp, current)
    } catch (err) {
      if (!isNotFoundError(err)) throw err
    }

    if (stats) {
      if (!isDirectoryStat(stats)) throw new Error(`Remote path exists and is not a directory: ${current}`)
      cache.add(current)
      continue
    }

    try {
      await sftpMkdir(sftp, current)
    } catch (err) {
      let createdStats = null
      try {
        createdStats = await sftpStat(sftp, current)
      } catch {}
      if (!createdStats || !isDirectoryStat(createdStats)) {
        throw new Error(`Failed to create remote directory ${current}: ${formatError(err)}`)
      }
    }
    cache.add(current)
  }
}

async function deployChanges (config, uploads, deletes, deployedManifest, currentManifest) {
  const { client, sftp } = await connectSftp(config)
  const ensuredDirs = new Set()

  try {
    for (const [index, relativePath] of uploads.entries()) {
      const localPath = path.join(PUBLIC_DIR, relativePath)
      const remotePath = path.posix.join(config.remotePath, relativePath)
      await ensureRemoteDir(sftp, path.posix.dirname(remotePath), ensuredDirs)
      console.log(`[upload ${index + 1}/${uploads.length}] ${relativePath}`)
      await sftpPut(sftp, localPath, remotePath)
      deployedManifest[relativePath] = currentManifest[relativePath]
      saveManifest(deployedManifest)
    }

    for (const [index, relativePath] of deletes.entries()) {
      const remotePath = path.posix.join(config.remotePath, relativePath)
      console.log(`[delete ${index + 1}/${deletes.length}] ${relativePath}`)
      try {
        await sftpUnlink(sftp, remotePath)
      } catch (err) {
        if (!isNotFoundError(err)) throw err
      }
      delete deployedManifest[relativePath]
      saveManifest(deployedManifest)
    }
  } finally {
    client.end()
  }
}

async function main () {
  const config = validateConfig()
  const currentManifest = await buildManifest()
  const previousManifest = sortManifest(loadManifest())
  const deployedManifest = { ...previousManifest }
  const { uploads, deletes } = diffManifest(previousManifest, currentManifest)

  console.log(isDryRun ? 'SFTP deploy dry-run' : 'SFTP deploy')
  console.log(`Scope: ${deployScope}`)
  console.log(`Local root: ${path.relative(ROOT, PUBLIC_DIR)}`)
  console.log(`Remote path: ${config.remotePath}`)
  console.log(`Uploads: ${uploads.length}`)
  console.log(`Deletes: ${deletes.length}`)

  for (const relativePath of uploads) console.log(`  upload ${relativePath}`)
  for (const relativePath of deletes) console.log(`  delete ${relativePath}`)

  if (!isDryRun) {
    if (uploads.length || deletes.length) {
      await deployChanges(config, uploads, deletes, deployedManifest, currentManifest)
    } else {
      console.log('No remote changes required.')
    }
    saveManifest(currentManifest)
    console.log(`Updated ${path.relative(ROOT, MANIFEST_PATH)}`)
  }
}

main().catch((err) => {
  console.error(formatError(err))
  process.exit(1)
})
