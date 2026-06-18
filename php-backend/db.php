<?php

declare(strict_types=1);

/**
 * Simple PDO database layer for shared-hosting PHP.
 */

require_once __DIR__ . '/config.php';

class Database
{
    private static ?PDO $pdo = null;

    public static function pdo(): PDO
    {
        if (self::$pdo === null) {
            $dsn = sprintf(
                'mysql:host=%s;port=%d;dbname=%s;charset=%s',
                DB_HOST,
                DB_PORT,
                DB_NAME,
                DB_CHARSET
            );
            $options = [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ];
            try {
                self::$pdo = new PDO($dsn, DB_USER, DB_PASS, $options);
            } catch (PDOException $e) {
                error_log('DB connection failed: ' . $e->getMessage());
                throw $e;
            }
        }
        return self::$pdo;
    }

    public static function isConnected(): bool
    {
        try {
            self::pdo()->query('SELECT 1');
            return true;
        } catch (Throwable) {
            return false;
        }
    }

    /**
     * Run a SELECT query with optional parameters.
     *
     * @param array<string,mixed> $params
     * @return array<int,array<string,mixed>>
     */
    public static function select(string $sql, array $params = []): array
    {
        $stmt = self::pdo()->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll();
    }

    /**
     * Run a SELECT returning a single row or null.
     *
     * @param array<string,mixed> $params
     * @return array<string,mixed>|null
     */
    public static function selectOne(string $sql, array $params = []): ?array
    {
        $stmt = self::pdo()->prepare($sql);
        $stmt->execute($params);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    /**
     * Run an INSERT/UPDATE/DELETE.
     *
     * @param array<string,mixed> $params
     */
    public static function execute(string $sql, array $params = []): int
    {
        $stmt = self::pdo()->prepare($sql);
        $stmt->execute($params);
        return $stmt->rowCount();
    }

    /**
     * Insert a row and return the last insert ID.
     *
     * @param array<string,mixed> $data
     */
    public static function insert(string $table, array $data): string|false
    {
        if (empty($data)) {
            return false;
        }
        $columns = array_keys($data);
        $placeholders = array_map(static fn ($col) => ':' . $col, $columns);
        $sql = sprintf(
            'INSERT INTO `%s` (`%s`) VALUES (%s)',
            $table,
            implode('`, `', $columns),
            implode(', ', $placeholders)
        );
        $stmt = self::pdo()->prepare($sql);
        $stmt->execute($data);
        return self::pdo()->lastInsertId();
    }

    /**
     * Update rows in a table.
     *
     * @param array<string,mixed> $data
     * @param array<string,mixed> $where
     */
    public static function update(string $table, array $data, array $where): int
    {
        if (empty($data) || empty($where)) {
            return 0;
        }
        $sets = [];
        $params = [];
        foreach ($data as $col => $val) {
            $key = 'set_' . $col;
            $sets[] = sprintf('`%s` = :%s', $col, $key);
            $params[$key] = $val;
        }
        $wheres = [];
        foreach ($where as $col => $val) {
            $key = 'where_' . $col;
            $wheres[] = sprintf('`%s` = :%s', $col, $key);
            $params[$key] = $val;
        }
        $sql = sprintf(
            'UPDATE `%s` SET %s WHERE %s',
            $table,
            implode(', ', $sets),
            implode(' AND ', $wheres)
        );
        return self::execute($sql, $params);
    }

    /**
     * Run a safe read, returning a default value on failure.
     *
     * @param array<string,mixed> $params
     * @return array<int,array<string,mixed>>
     */
    public static function safeSelect(string $sql, array $params = [], array $default = []): array
    {
        try {
            return self::select($sql, $params);
        } catch (Throwable $e) {
            error_log('DB safeSelect error: ' . $e->getMessage());
            return $default;
        }
    }

    /**
     * Run a safe write, returning row count or 0 on failure.
     *
     * @param array<string,mixed> $params
     */
    public static function safeExecute(string $sql, array $params = []): int
    {
        try {
            return self::execute($sql, $params);
        } catch (Throwable $e) {
            error_log('DB safeExecute error: ' . $e->getMessage());
            return 0;
        }
    }

    /**
     * Safe insert returning last insert ID or false.
     *
     * @param array<string,mixed> $data
     */
    public static function safeInsert(string $table, array $data): string|false
    {
        try {
            return self::insert($table, $data);
        } catch (Throwable $e) {
            error_log('DB safeInsert error: ' . $e->getMessage());
            return false;
        }
    }
}

/**
 * Decode JSON columns from a row.
 *
 * @param array<string,mixed> $row
 * @param array<int,string> $columns
 * @return array<string,mixed>
 */
function decodeJsonColumns(array $row, array $columns): array
{
    foreach ($columns as $col) {
        if (isset($row[$col]) && is_string($row[$col]) && $row[$col] !== '') {
            $decoded = json_decode($row[$col], true);
            $row[$col] = $decoded ?? $row[$col];
        }
    }
    return $row;
}

/**
 * Encode values to JSON for storage.
 *
 * @param array<string,mixed>|null $value
 */
function jsonEncodeNullable(?array $value): ?string
{
    return $value === null ? null : json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}
