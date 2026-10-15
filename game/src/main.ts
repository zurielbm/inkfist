import './style.css';
import { App } from './app';
import { settings } from './ui/settings';

const app = new App();
app.boot().then(() => {
  app.r.post.u.uBoil.value = settings.boil;
  if (settings.quality === 'low') app.applyQuality();
});
(window as unknown as { inkfist: App }).inkfist = app;
