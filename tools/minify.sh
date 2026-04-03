# npm install uglify-js -g

uglifyjs  --compress --mangle -o assets/qrcode.min.js -- assets/qrcode.js
uglifyjs  --compress --mangle -o assets/client-shared.min.js -- assets/client-shared.js
uglifyjs  --compress --mangle -o assets/client-send.min.js -- assets/client-send.js
uglifyjs  --compress --mangle -o assets/client-receive.min.js -- assets/client-receive.js
uglifyjs  --compress --mangle -o assets/client.min.js -- assets/client.js
