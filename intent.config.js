'use strict';

// Re-export shim — intent weights live in signals.config.js
// Import this file if you only need the intent weights
module.exports = require('./signals.config.js').intent;
