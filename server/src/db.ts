import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const CREATE_MESSAGES_TABLE_SQL = `
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    sender_ip TEXT NOT NULL,
    sender_nickname TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text', 'image', 'file')),
    text_content TEXT,
    file_path TEXT,
    file_name TEXT,
    file_mime TEXT,
    file_size INTEGER,
    is_recalled INTEGER NOT NULL DEFAULT 0,
    recalled_at TEXT,
    recalled_by_ip TEXT,
    mention_all INTEGER NOT NULL DEFAULT 0,
    mentioned_ips TEXT NOT NULL DEFAULT '[]',
    edited_at TEXT,
    task_payload TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(room_id),
    FOREIGN KEY (sender_ip) REFERENCES profiles(ip)
  );
`;

export function openDatabase(databasePath: string): Database.Database {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');

  database.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      ip TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      room_name TEXT NOT NULL,
      owner_ip TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'dissolved')),
      created_at TEXT NOT NULL,
      dissolved_at TEXT,
      FOREIGN KEY (owner_ip) REFERENCES profiles(ip)
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL,
      member_ip TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
      status TEXT NOT NULL CHECK (status IN ('active', 'left')),
      joined_at TEXT NOT NULL,
      left_at TEXT,
      last_seen_message_id INTEGER,
      PRIMARY KEY (room_id, member_ip),
      FOREIGN KEY (room_id) REFERENCES rooms(room_id),
      FOREIGN KEY (member_ip) REFERENCES profiles(ip)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      sender_ip TEXT NOT NULL,
      sender_nickname TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('text', 'image', 'file')),
      text_content TEXT,
      file_path TEXT,
      file_name TEXT,
      file_mime TEXT,
      file_size INTEGER,
      is_recalled INTEGER NOT NULL DEFAULT 0,
      recalled_at TEXT,
      recalled_by_ip TEXT,
      mention_all INTEGER NOT NULL DEFAULT 0,
      mentioned_ips TEXT NOT NULL DEFAULT '[]',
      edited_at TEXT,
      task_payload TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(room_id),
      FOREIGN KEY (sender_ip) REFERENCES profiles(ip)
    );

    CREATE TABLE IF NOT EXISTS pending_uploads (
      upload_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      uploader_ip TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('image', 'file')),
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_mime TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(room_id),
      FOREIGN KEY (uploader_ip) REFERENCES profiles(ip)
    );

    CREATE INDEX IF NOT EXISTS idx_room_members_member_status ON room_members(member_ip, status);
    CREATE INDEX IF NOT EXISTS idx_room_members_room_status ON room_members(room_id, status);
    CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_pending_uploads_room_uploader ON pending_uploads(room_id, uploader_ip, created_at DESC);
  `);

  migrateRoomsTable(database);
  migrateRoomMembersTable(database);
  migrateMessagesTable(database);

  return database;
}

function migrateRoomsTable(database: Database.Database) {
  const columns = database.prepare<[], { name: string }>('PRAGMA table_info(rooms)').all();
  const hasRoomNameColumn = columns.some((column) => column.name === 'room_name');

  const migrate = database.transaction(() => {
    if (!hasRoomNameColumn) {
      database.exec(`ALTER TABLE rooms ADD COLUMN room_name TEXT;`);
    }

    database.exec(`
      UPDATE rooms
      SET room_name = '房间 ' || room_id
      WHERE room_name IS NULL OR TRIM(room_name) = '';
    `);
  });

  migrate();
}

function migrateRoomMembersTable(database: Database.Database) {
  const columns = database.prepare<[], { name: string }>('PRAGMA table_info(room_members)').all();
  const hasLastSeenMessageIdColumn = columns.some((column) => column.name === 'last_seen_message_id');

  const migrate = database.transaction(() => {
    if (!hasLastSeenMessageIdColumn) {
      database.exec(`ALTER TABLE room_members ADD COLUMN last_seen_message_id INTEGER;`);
    }

    database.exec(`
      UPDATE room_members
      SET last_seen_message_id = (
        SELECT MAX(messages.id)
        FROM messages
        WHERE messages.room_id = room_members.room_id
      )
      WHERE status = 'active' AND last_seen_message_id IS NULL;
    `);
  });

  migrate();
}

function migrateMessagesTable(database: Database.Database) {
  const columns = database.prepare<[], { name: string }>('PRAGMA table_info(messages)').all();
  const hasFileColumns = columns.some((column) => column.name === 'file_path');
  const hasLegacyImageColumns = columns.some((column) => column.name === 'image_path');
  const hasRecallColumns = ['is_recalled', 'recalled_at', 'recalled_by_ip'].every((name) =>
    columns.some((column) => column.name === name),
  );
  const hasMentionColumns = ['mention_all', 'mentioned_ips'].every((name) =>
    columns.some((column) => column.name === name),
  );
  const hasEditedAtColumn = columns.some((column) => column.name === 'edited_at');
  const hasTaskPayloadColumn = columns.some((column) => column.name === 'task_payload');
  const tableSql = database
    .prepare<[string, string], { sql: string }>('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', 'messages')?.sql;
  const supportsFileType = tableSql?.includes("'file'") ?? false;

  if (hasFileColumns && supportsFileType && hasRecallColumns && hasMentionColumns && hasEditedAtColumn && hasTaskPayloadColumn) {
    return;
  }

  const selectFilePath = hasLegacyImageColumns ? 'image_path' : hasFileColumns ? 'file_path' : 'NULL';
  const selectFileName = hasLegacyImageColumns ? 'image_name' : hasFileColumns ? 'file_name' : 'NULL';
  const selectFileMime = hasLegacyImageColumns ? 'image_mime' : hasFileColumns ? 'file_mime' : 'NULL';
  const selectFileSize = hasLegacyImageColumns ? 'image_size' : hasFileColumns ? 'file_size' : 'NULL';
  const selectIsRecalled = hasRecallColumns ? 'is_recalled' : '0';
  const selectRecalledAt = hasRecallColumns ? 'recalled_at' : 'NULL';
  const selectRecalledByIp = hasRecallColumns ? 'recalled_by_ip' : 'NULL';
  const selectMentionAll = hasMentionColumns ? 'mention_all' : '0';
  const selectMentionedIps = hasMentionColumns ? 'mentioned_ips' : "'[]'";
  const selectEditedAt = hasEditedAtColumn ? 'edited_at' : 'NULL';
  const selectTaskPayload = hasTaskPayloadColumn ? 'task_payload' : 'NULL';

  const migrate = database.transaction(() => {
    database.exec(`ALTER TABLE messages RENAME TO messages_legacy;`);
    database.exec(CREATE_MESSAGES_TABLE_SQL);
    database.exec(`
      INSERT INTO messages (
        id,
        room_id,
        sender_ip,
        sender_nickname,
        type,
        text_content,
        file_path,
        file_name,
        file_mime,
        file_size,
        is_recalled,
        recalled_at,
        recalled_by_ip,
        mention_all,
        mentioned_ips,
        edited_at,
        task_payload,
        created_at
      )
      SELECT
        id,
        room_id,
        sender_ip,
        sender_nickname,
        type,
        text_content,
        ${selectFilePath},
        ${selectFileName},
        ${selectFileMime},
        ${selectFileSize},
        ${selectIsRecalled},
        ${selectRecalledAt},
        ${selectRecalledByIp},
        ${selectMentionAll},
        ${selectMentionedIps},
        ${selectEditedAt},
        ${selectTaskPayload},
        created_at
      FROM messages_legacy;
    `);
    database.exec(`
      DROP TABLE messages_legacy;
      CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_pending_uploads_room_uploader ON pending_uploads(room_id, uploader_ip, created_at DESC);
    `);
  });

  migrate();
}
