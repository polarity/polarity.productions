#!/usr/bin/env php
<?php

$repoRoot = dirname(__DIR__);
$defaultConfigPath = dirname($repoRoot) . '/app.dispenser/dispenser/config.php';
$configPath = getenv('DISPENSER_CONFIG_PATH') ?: $defaultConfigPath;
$outputPath = $argv[1] ?? ($repoRoot . '/.buildt/dispenser-db-export.sql');

if (!is_file($configPath)) {
    fwrite(STDERR, 'Missing Dispenser config: ' . $configPath . PHP_EOL);
    exit(1);
}

$config = require $configPath;
if (!is_array($config) || empty($config['db']) || !is_array($config['db'])) {
    fwrite(STDERR, 'Invalid Dispenser config: missing db block.' . PHP_EOL);
    exit(1);
}

$db = $config['db'];
$host = (string)($db['host'] ?? '127.0.0.1');
$port = (int)($db['port'] ?? 3306);
$name = (string)($db['database'] ?? '');
$user = (string)($db['user'] ?? '');
$pass = (string)($db['password'] ?? '');

if ($name === '' || $user === '') {
    fwrite(STDERR, 'Invalid Dispenser config: db.database and db.user are required.' . PHP_EOL);
    exit(1);
}

try {
    $pdo = new PDO(
        "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4",
        $user,
        $pass,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::MYSQL_ATTR_USE_BUFFERED_QUERY => false,
        ]
    );
} catch (Throwable $e) {
    fwrite(STDERR, 'DB connection failed: ' . $e->getMessage() . PHP_EOL);
    exit(1);
}

$outDir = dirname($outputPath);
if (!is_dir($outDir) && !mkdir($outDir, 0775, true)) {
    fwrite(STDERR, 'Could not create output directory: ' . $outDir . PHP_EOL);
    exit(1);
}

$handle = fopen($outputPath, 'wb');
if (!$handle) {
    fwrite(STDERR, 'Could not write dump file: ' . $outputPath . PHP_EOL);
    exit(1);
}

function write_line($handle, string $line = ''): void
{
    fwrite($handle, $line . "\n");
}

function quote_identifier(string $identifier): string
{
    return '`' . str_replace('`', '``', $identifier) . '`';
}

function list_tables(PDO $pdo): array
{
    $tables = [];
    $stmt = $pdo->query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"');
    while ($row = $stmt->fetch(PDO::FETCH_NUM)) {
        if (!empty($row[0])) {
            $tables[] = (string)$row[0];
        }
    }
    sort($tables, SORT_NATURAL | SORT_FLAG_CASE);
    return $tables;
}

function export_table(PDO $pdo, $handle, string $table): int
{
    $quotedTable = quote_identifier($table);
    $createRows = $pdo->query('SHOW CREATE TABLE ' . $quotedTable)->fetch();
    $createSql = $createRows['Create Table'] ?? array_values($createRows)[1] ?? '';
    if ($createSql === '') {
        throw new RuntimeException('Could not read CREATE TABLE for ' . $table);
    }

    write_line($handle);
    write_line($handle, 'DROP TABLE IF EXISTS ' . $quotedTable . ';');
    write_line($handle, $createSql . ';');

    $columns = [];
    $columnStmt = $pdo->query('SHOW COLUMNS FROM ' . $quotedTable);
    while ($column = $columnStmt->fetch()) {
        $columns[] = $column['Field'];
    }

    if (!$columns) {
        return 0;
    }

    $rowCount = 0;
    $quotedColumns = implode(', ', array_map('quote_identifier', $columns));
    $select = $pdo->query('SELECT * FROM ' . $quotedTable);
    $batch = [];
    $batchSize = 100;

    while ($row = $select->fetch()) {
        $values = [];
        foreach ($columns as $column) {
            $value = $row[$column] ?? null;
            $values[] = $value === null ? 'NULL' : $pdo->quote((string)$value);
        }
        $batch[] = '(' . implode(', ', $values) . ')';
        $rowCount++;

        if (count($batch) >= $batchSize) {
            write_line($handle, 'INSERT INTO ' . $quotedTable . ' (' . $quotedColumns . ') VALUES');
            write_line($handle, implode(",\n", $batch) . ';');
            $batch = [];
        }
    }

    if ($batch) {
        write_line($handle, 'INSERT INTO ' . $quotedTable . ' (' . $quotedColumns . ') VALUES');
        write_line($handle, implode(",\n", $batch) . ';');
    }

    return $rowCount;
}

try {
    write_line($handle, '-- Polarity Dispenser DB export generated ' . gmdate('c'));
    write_line($handle, 'SET NAMES utf8mb4;');
    write_line($handle, 'SET FOREIGN_KEY_CHECKS=0;');

    $counts = [];
    foreach (list_tables($pdo) as $table) {
        $counts[$table] = export_table($pdo, $handle, $table);
    }

    write_line($handle);
    write_line($handle, 'SET FOREIGN_KEY_CHECKS=1;');
} catch (Throwable $e) {
    fclose($handle);
    fwrite(STDERR, 'Export failed: ' . $e->getMessage() . PHP_EOL);
    exit(1);
}

fclose($handle);
echo 'Wrote ' . $outputPath . PHP_EOL;
foreach ($counts as $table => $count) {
    echo $table . ': ' . $count . PHP_EOL;
}
