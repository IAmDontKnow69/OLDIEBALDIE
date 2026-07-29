const storage = require('node-persist');

module.exports = {
  init: async () => {
    await storage.init({ dir: 'data', stringify: JSON.stringify, parse: JSON.parse, encoding: 'utf8' });
  },
  get: async (key) => {
    return storage.getItem(key);
  },
  set: async (key, value) => {
    return storage.setItem(key, value);
  },
  remove: async (key) => {
    return storage.removeItem(key);
  }
};
