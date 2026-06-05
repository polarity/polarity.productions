#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const GITHUB_ROOT = path.resolve(ROOT, '..')
const PUBLIC_DIR = path.join(ROOT, 'public')

const SOURCES = [
  { name: 'root', source: ROOT, target: '' },
  { name: 'polarity-res', source: path.join(GITHUB_ROOT, 'webpage.polarity-res'), target: 'polarity-res' },
  { name: 'polarity-md', source: path.join(GITHUB_ROOT, 'webpage.polarity-md'), target: 'polarity-md' },
  { name: 'polarity-sc', source: path.join(GITHUB_ROOT, 'webpage.polarity-sc-dark'), target: 'polarity-sc' },
  { name: 'spectrogram', source: path.join(GITHUB_ROOT, 'app.spectrogram'), target: 'spectrogram' },
  { name: 'spectrum', source: path.join(GITHUB_ROOT, 'app.spectrum.analyzer'), target: 'spectrum' },
  { name: 'vectorscope', source: path.join(GITHUB_ROOT, 'app.vectorscope'), target: 'vectorscope' },
  { name: 'dispenser', source: path.join(GITHUB_ROOT, 'app.dispenser', 'dispenser'), target: 'dispenser' }
]

const ROOT_EXCLUDES = new Set([
  '.buildt',
  '.git',
  '.github',
  '.vscode',
  'docs',
  'node_modules',
  'public',
  'scripts',
  '.gitignore',
  'package.json',
  'package-lock.json',
  'sftp-config.example.json',
  'uberspace-config.example.json',
  'README.md'
])

const COMMON_EXCLUDES = new Set([
  '.buildt',
  '.git',
  '.github',
  '.vscode',
  'node_modules',
  'AGENTS.md',
  'agents.md',
  'README.md',
  'package.json',
  'package-lock.json',
  '.gitignore',
  '.cursorrules'
])

const DISPENSER_EXCLUDES = new Set([
  'config.php',
  'config.sample.php',
  '__config.php'
])

function normalizeRelativePath (relativePath) {
  return String(relativePath || '').split(path.sep).join('/')
}

function isInside (child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function ensureSafePublicDir () {
  const resolved = path.resolve(PUBLIC_DIR)
  if (!isInside(resolved, ROOT) || resolved === ROOT) {
    throw new Error(`Refusing to clear unsafe public directory: ${resolved}`)
  }
}

function shouldSkip (sourceName, relativePath, entry) {
  const rel = normalizeRelativePath(relativePath)
  const top = rel.split('/')[0]

  if (sourceName === 'root' && ROOT_EXCLUDES.has(top)) return true
  if (sourceName !== 'root' && COMMON_EXCLUDES.has(top)) return true

  if (sourceName === 'dispenser') {
    if (DISPENSER_EXCLUDES.has(rel)) return true
    if (rel === 'uploads' || rel.startsWith('uploads/')) return true
  }

  if (entry.isDirectory()) return false
  if (rel.endsWith('.log')) return true
  return false
}

function copyTree (sourceDir, targetDir, sourceName, stats) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Missing source for ${sourceName}: ${sourceDir}`)
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))

  fs.mkdirSync(targetDir, { recursive: true })

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const relativePath = path.relative(sourceDir, sourcePath)

    if (shouldSkip(sourceName, relativePath, entry)) {
      continue
    }

    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      copyTree(sourcePath, targetPath, sourceName, stats)
      continue
    }

    if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath)
      stats.files += 1
      stats.bytes += fs.statSync(sourcePath).size
    }
  }
}

function main () {
  ensureSafePublicDir()
  fs.rmSync(PUBLIC_DIR, { recursive: true, force: true })
  fs.mkdirSync(PUBLIC_DIR, { recursive: true })

  for (const source of SOURCES) {
    const targetDir = path.join(PUBLIC_DIR, source.target)
    const stats = { files: 0, bytes: 0 }
    copyTree(source.source, targetDir, source.name, stats)
    console.log(`${source.target || '/'} <- ${source.source}`)
    console.log(`  ${stats.files} files, ${Math.round(stats.bytes / 1024)} KiB`)
  }

  console.log(`Assembled ${PUBLIC_DIR}`)
}

main()
