## Backups

By default, Isomux stores seven daily backups of `~/.isomux/` in the server's backup directory on the same disk as the office, so copy them elsewhere if you need protection from server loss. The office owner can change how often, how many and the directory in Settings → Office → Storage. Current backup health and the exact directory are at `GET /api/backup/status`. To erase office data, see [Data retention and deletion](data-retention.md).
