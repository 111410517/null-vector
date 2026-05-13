import { registerSW } from 'virtual:pwa-register';

if ('serviceWorker' in navigator) {
  registerSW({
    onNeedRefresh() {
      console.log('New content available, click to refresh.');
    },
    onOfflineReady() {
      console.log('Game is ready for offline play.');
    },
  });
}
