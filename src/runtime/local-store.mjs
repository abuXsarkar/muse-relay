import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filename) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
  return {
    exec(statement, ...args) {
      const rows = db.prepare(statement).all(...args);
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
    transactionSync(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => db.close(),
  };
}
