const PORT_MESSAGE = 'jsonlens:export-port';

/**
 * Asks preload for a MessageChannel whose other end is wired to main's file writer for `exportId`,
 * and resolves with this end (delivered via window.postMessage, since ports can't cross contextBridge).
 */
export function getExportPort(exportId: number): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Could not open the export channel'));
    }, 5000);
    function onMessage(e: MessageEvent): void {
      const d = e.data as { type?: string; exportId?: number } | null;
      if (d?.type === PORT_MESSAGE && d.exportId === exportId && e.ports[0]) {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(e.ports[0]);
      }
    }
    window.addEventListener('message', onMessage);
    window.api.openExportPort(exportId);
  });
}
