import { open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Windows readers may briefly deny delete-sharing. Never unlink the published
 * checkpoint to work around that lock: readers must see a complete old or new file. */
export async function replaceFileWithRetry(source, destination, {
  attempts = 12, renameFile = rename, wait = delay, onRetry = () => {},
} = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 32) throw new Error('invalid-rename-attempts');
  for (let attempt = 1; ; attempt++) {
    try { await renameFile(source, destination); return; }
    catch (error) {
      if (!TRANSIENT_RENAME_ERRORS.has(error.code) || attempt >= attempts) throw error;
      const milliseconds = Math.min(500, 50 * 2 ** (attempt - 1));
      onRetry({ code: error.code, attempt, milliseconds, destination });
      await wait(milliseconds);
    }
  }
}

/** Flush complete bytes to a unique sibling, then publish by atomic replacement.
 * On persistent failure, keep both the old checkpoint and the recoverable sibling. */
export async function atomicWriteFile(destination, data, options = {}) {
  const temporary = `${destination}.pending-${randomUUID()}`;
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
  try { await replaceFileWithRetry(temporary, destination, options); }
  catch (cause) {
    const error = new Error(`atomic-replace-failed: ${destination}; unpublished snapshot retained at ${temporary}`, { cause });
    error.code = cause.code; error.pendingFile = temporary;
    throw error;
  }
}
