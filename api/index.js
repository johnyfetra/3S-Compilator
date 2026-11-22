// Fonction Vercel : toutes les routes /api/* arrivent ici (voir la réécriture dans vercel.json).
const { createHandler } = require('./_lib/api');

module.exports = createHandler(process.env);
