const { join } = require('path');

/**
 * Puppeteer configuration for Heroku deployment.
 * Tells Puppeteer where to store/find the Chromium binary.
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // On Heroku, cache Chromium in the node_modules directory so it persists across deploys
  cacheDirectory: join(__dirname, 'node_modules', '.cache', 'puppeteer'),
};
