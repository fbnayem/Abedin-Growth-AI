const fs = require('fs');
let data = fs.readFileSync('server/data_storage.json', 'utf8');
data = data.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""); // strip all control characters
fs.writeFileSync('server/data_storage.json', data);
