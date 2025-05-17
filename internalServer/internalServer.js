const express = require('express');
const path = require('path');
const fs = require('fs'); 
require('dotenv').config();

const PORT = 3000;
const POINTCLOUDS_BASE_DIR = path.resolve(__dirname, 'pointclouds'); 

const app = express();

const EXPECTED_GULP_PROXY_HEADER_NAME = 'X-Internal-Proxy-Auth'; 
const EXPECTED_GULP_PROXY_HEADER_VALUE = process.env.SERVER_SIDE_HEADER; 

console.log(process.env.SERVER_SIDE_HEADER)


app.use(express.static(POINTCLOUDS_BASE_DIR, {
    dotfiles: 'ignore',
    etag: true,
    extensions: false,
    index: false, 
    maxAge: '1d',
    redirect: false,
    setHeaders: function (res, filePath, stat) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
}));

app.use((req, res, next) => {
    const receivedSecret = req.get(EXPECTED_GULP_PROXY_HEADER_NAME);
    if (req.method === 'GET') {
        if (receivedSecret && receivedSecret === EXPECTED_GULP_PROXY_HEADER_VALUE) {
            next();
        } else {
            res.status(403).send('Forbidden: Direct access not allowed to internal server.');
        }
    } else { next(); }
});


app.use((req, res, next) => {
    const attemptedFilePath = path.normalize(path.join(POINTCLOUDS_BASE_DIR, req.url));
    console.error(`[Internal Server 3000] FINAL 404: File not served by express.static. Path was: ${attemptedFilePath}`);
    res.status(404).send(`File not found on internal server: ${req.url}`);
});

app.use((err, req, res, next) => {
    console.error("[Internal Server 3000] Error Middleware:", err.stack);
    res.status(500).send('Internal Server Error on port 3000');
});

app.listen(PORT, () => {
    console.log('Middleware server running on port',PORT);
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Error: Port ${PORT} is already in use. Please choose a different port.`);
    } else {
        console.error(`Server error: ${err}`);
    }
    process.exit(1);
});