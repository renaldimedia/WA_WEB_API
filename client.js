// whatsapp-multiclient-api/client.js

const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.listen(4000, () => {
  console.log('Client preview ready at http://localhost:4000');
});
