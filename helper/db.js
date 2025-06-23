const knexConfig = require('../knexfile')
// db.js
const knex = require('knex')(knexConfig.development);

module.exports = knex;
