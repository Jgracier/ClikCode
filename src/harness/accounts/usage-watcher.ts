/** File watcher for instant account usage cache invalidation across terminals. */
import { watch, type FSWatcher } from 'node:fs';
import { harnessIndexPath } from '../../session/state/paths.js';
import { nativeUsageCache } from './usage-reading.js';

// ---------------------------------------------------------------------------
// File watcher for instant cache invalidation
// ---------------------------------------------------------------------------

let indexWatcher: FSWatcher | undefined;
let watchDebounceTimer: NodeJS.Timeout | undefined;

/** Start watching index.json for account changes and invalidate cache entries
 * when it changes. This makes usage updates instant across all terminals.
 * 
 * Changes are debounced (150ms) to handle multiple rapid writes. If the file
 * can't be watched (network filesystem, exhausted inotify), this fails silently
 * and the existing 30s polling continues as fallback. */
export function watchAccountUsage(): { stop: () => void } {
  if (indexWatcher) return { stop: () => stopWatchingAccountUsage() };
  
  try {
    const indexPath = harnessIndexPath();
    indexWatcher = watch(indexPath, { persistent: false }, (_event, _filename) => {
      if (watchDebounceTimer) return;
      watchDebounceTimer = setTimeout(() => {
        watchDebounceTimer = undefined;
        // Invalidate all account cache entries when the index changes.
        // Keys look like "harness:account:accountId" or "harness:session:sessionId".
        for (const [key] of nativeUsageCache) {
          if (key.includes(':account:')) nativeUsageCache.delete(key);
        }
      }, 150);
      watchDebounceTimer.unref?.();
    });
    
    indexWatcher.on('error', () => {
      // Fail silently on watch errors (ENOENT, ENOSPC, network filesystem).
      // The 30s polling continues as fallback.
      stopWatchingAccountUsage();
    });
    
    return { stop: () => stopWatchingAccountUsage() };
  } catch {
    // Watch not available - polling continues as fallback.
    return { stop: () => undefined };
  }
}

function stopWatchingAccountUsage(): void {
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer);
    watchDebounceTimer = undefined;
  }
  if (indexWatcher) {
    indexWatcher.close();
    indexWatcher = undefined;
  }
}
