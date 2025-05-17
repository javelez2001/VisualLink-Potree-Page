const path = require('path');
const gulp = require('gulp');
const exec = require('child_process').exec;
const fs = require("fs");
const fsp = fs.promises;
const concat = require('gulp-concat');
const connect = require('gulp-connect');
const { watch } = gulp;
const { deleteAsync: del } = require('del');
const axios = require('axios');
require('dotenv').config();

const OUTPUT_DIR = 'dist';
const HTML_SOURCE_FILE = 'index.html'; 
const LIBS_SOURCE_DIR = 'libs'; 
const INTERNAL_POINTCLOUD_SERVER_BASE_URL = 'http://localhost:3000';


const GULP_PROXY_TO_INTERNAL_HEADER_NAME = 'X-Internal-Proxy-Auth';
const GULP_PROXY_TO_INTERNAL_HEADER_VALUE = process.env.SERVER_SIDE_HEADER; 


const CLIENT_TO_GULP_PROXY_HEADER_NAME = 'X-Potree-Client-Request';
const CLIENT_TO_GULP_PROXY_HEADER_VALUE = 'SUhKJvctHSizWgnv5LqoTsQr'; // Client Side, no reason to hide



const potreeSources = {
    css: "src/viewer/potree.css", 
    resources: "resources/**/*",  
    workers: { 
        "LASLAZWorker": [
            "libs/plasio/workers/laz-perf.js", 
            "libs/plasio/workers/laz-loader-worker.js"
        ],
        "LASDecoderWorker": [
            "src/workers/LASDecoderWorker.js"
        ],
        "EptLaszipDecoderWorker": [
            "libs/copc/index.js",
            "src/workers/EptLaszipDecoderWorker.js",
        ],
        "EptBinaryDecoderWorker": [
            "libs/ept/ParseBuffer.js",
            "src/workers/EptBinaryDecoderWorker.js"
        ],
        "EptZstandardDecoderWorker": [
            "src/workers/EptZstandardDecoder_preamble.js",
            'libs/zstd-codec/bundle.js',
            "libs/ept/ParseBuffer.js",
            "src/workers/EptZstandardDecoderWorker.js"
        ]
    },
    wasm: './libs/copc/laz-perf.wasm', 
    shaders: [ 
        "src/materials/shaders/pointcloud.vs",
        "src/materials/shaders/pointcloud.fs",
        "src/materials/shaders/pointcloud_sm.vs",
        "src/materials/shaders/pointcloud_sm.fs",
        "src/materials/shaders/normalize.vs",
        "src/materials/shaders/normalize.fs",
        "src/materials/shaders/normalize_and_edl.fs",
        "src/materials/shaders/edl.vs",
        "src/materials/shaders/edl.fs",
        "src/materials/shaders/blur.vs",
        "src/materials/shaders/blur.fs",
    ]
};

const potreeOutputPaths = {
    base: path.join(OUTPUT_DIR, 'libs', 'potree'),
    css: path.join(OUTPUT_DIR, 'libs', 'potree'), // potree.css will go here
    js: path.join(OUTPUT_DIR, 'libs', 'potree'),   // potree.js (from rollup) will go here
    workers: path.join(OUTPUT_DIR, 'libs', 'potree', 'workers'),
    resources: path.join(OUTPUT_DIR, 'libs', 'potree', 'resources'),
    shaders: path.join(OUTPUT_DIR, 'libs', 'potree', 'shaders') // shaders.js will go here
};


gulp.task('clean', function () {
    return del([OUTPUT_DIR]);
});

gulp.task('copy-html', function () {
    console.log(`Copying ${HTML_SOURCE_FILE} to ${OUTPUT_DIR}`);
    return gulp.src(HTML_SOURCE_FILE)
        .pipe(gulp.dest(OUTPUT_DIR))
        .on('end', () => console.log(`${HTML_SOURCE_FILE} copied successfully.`));
});


gulp.task('copy-all-libs', function () {
    return gulp.src(path.join(LIBS_SOURCE_DIR, '**/*'))
        .pipe(gulp.dest(path.join(OUTPUT_DIR, 'libs')));
});


gulp.task('copy-potree-css', function () {
    return gulp.src(potreeSources.css)
        .pipe(gulp.dest(potreeOutputPaths.css)); 
});

gulp.task('copy-potree-resources', function () {
    return gulp.src(potreeSources.resources)
        .pipe(gulp.dest(potreeOutputPaths.resources)); 
});

gulp.task("build-potree-workers", async function (done) {
    const workerDest = potreeOutputPaths.workers;
    if (!fs.existsSync(workerDest)) {
        fs.mkdirSync(workerDest, { recursive: true });
    }
    for (let workerName of Object.keys(potreeSources.workers)) {
        gulp.src(potreeSources.workers[workerName])
            .pipe(concat(`${workerName}.js`))
            .pipe(gulp.dest(workerDest));
    }
    gulp.src(potreeSources.wasm)
        .pipe(gulp.dest(workerDest));
    done();
});


gulp.task("build-potree-shaders", async function () {
    const components = ["let Shaders = {};"];
    for (let file of potreeSources.shaders) {
        const filename = path.basename(file);
        const content = await fsp.readFile(file);
        const prep = `Shaders["${filename}"] = \`${content}\`;`;
        components.push(prep);
    }
    components.push("export {Shaders};");
    const content = components.join("\n\n");

    const shadersDestDir = potreeOutputPaths.shaders;
    if (!fs.existsSync(shadersDestDir)) {
        fs.mkdirSync(shadersDestDir, { recursive: true });
    }
    fs.writeFileSync(path.join(shadersDestDir, 'shaders.js'), content, { flag: "w" });
});


gulp.task("bundle-potree-js", function (cb) {
    console.log(`Running Rollup. Expecting output at: ${path.join(potreeOutputPaths.js, 'potree.js')}`);
    exec('rollup -c', function (err, stdout, stderr) {
        console.log(stdout);
        console.log(stderr);
        if (err) {
            console.error("Rollup failed:", err);
        }
        cb(err);
    });
});


gulp.task('build-potree-core', gulp.series(
    'copy-potree-css',
    'copy-potree-resources',
    'build-potree-workers',
    'build-potree-shaders',
    'bundle-potree-js' 
));


gulp.task('build',
    gulp.series(
        'clean',
        gulp.parallel(
            'copy-html',
            'copy-all-libs' 
        ),
        'build-potree-core' 
    )
);

// Webserver in port 1234, and middleware for pointclouds in port 3000
gulp.task('webserver', function (done) {
    const PROXY_PATH_PREFIX = '/proxied-pointclouds';
    connect.server({
        name: 'VisualLink',
        root: [OUTPUT_DIR, '.'], 
        port: 1234,
        livereload: true,
        host: '0.0.0.0',
        index: HTML_SOURCE_FILE, 
        middleware: function (connectInstance, opt) {
            return [
                function clientAuthMiddleware(req, res, next) {
                    if (req.url.startsWith(PROXY_PATH_PREFIX)) {
                        const clientHeaderValue = req.headers[CLIENT_TO_GULP_PROXY_HEADER_NAME.toLowerCase()]; 

                        if (clientHeaderValue && clientHeaderValue === CLIENT_TO_GULP_PROXY_HEADER_VALUE) {
                            console.log(`[Gulp Server] Valid client header for ${req.url}. Proceeding to proxy.`);
                            return next(); 
                        } else {
                            console.warn(`[Gulp Server] Forbidden: Missing or invalid client header for ${req.url}. Received: '${clientHeaderValue}'`);
                            res.statusCode = 403; // Forbidden
                            return res.end('Forbidden: Direct access to this resource is not allowed.');
                        }
                    }

                    return next();
                },


                async function pointCloudProxyMiddleware(req, res, next) {
                    if (req.url.startsWith(PROXY_PATH_PREFIX)) {
                        const resourcePath = req.url.substring(PROXY_PATH_PREFIX.length);
                        const targetUrl = `${INTERNAL_POINTCLOUD_SERVER_BASE_URL}${resourcePath}`;

                        console.log(`[Gulp Proxy] Authenticated client request: ${req.url}`);
                        console.log(`[Gulp Proxy] Fetching from internal: ${targetUrl}`);

                        try {
                            const responseFromInternal = await axios({
                                method: 'GET',
                                url: targetUrl,
                                responseType: 'stream',
                                headers: { 
                                    [GULP_PROXY_TO_INTERNAL_HEADER_NAME]: GULP_PROXY_TO_INTERNAL_HEADER_VALUE
                                }
                            });

                            if (responseFromInternal.headers['content-type']) {
                                res.setHeader('Content-Type', responseFromInternal.headers['content-type']);
                            }
                            if (responseFromInternal.headers['content-length']) {
                                res.setHeader('Content-Length', responseFromInternal.headers['content-length']);
                            }

                            res.writeHead(responseFromInternal.status);
                            responseFromInternal.data.pipe(res);

                        } catch (error) {
                            console.error(`[Gulp Proxy] Error fetching from ${targetUrl}:`, error.message);
                            if (error.response) {
                                console.error(`[Gulp Proxy] Internal server status: ${error.response.status}`);
                                res.writeHead(error.response.status);
                                if (error.response.data && typeof error.response.data.pipe === 'function') {
                                    error.response.data.pipe(res);
                                } else if (error.response.data) {
                                    res.end(JSON.stringify(error.response.data));
                                } else {
                                    res.end(error.message);
                                }
                            } else {
                                res.statusCode = 502; // Bad Gateway
                                res.end('Error: Could not reach internal point cloud server.');
                            }
                        }
                    } else {
                        
                        return next();
                    }
                }
            ];
        }
    });
    if (done) done(); 
});

// Watch for changes and rebuild
gulp.task('watch-changes', function () {
    const reload = () => gulp.src(HTML_SOURCE_FILE, { read: false, allowEmpty: true }).pipe(connect.reload());


    watch([
        'src/**/*.js',
        'src/**/*.css', 
        'src/**/*.html',
        'src/**/*.vs',
        'src/**/*.fs',
        potreeSources.resources, 
        'libs/plasio/**/*',
        'libs/copc/**/*',   
        'libs/zstd-codec/**/*',
        'libs/ept/**/*' 
    ], gulp.series('build-potree-core', reload));


    watch(HTML_SOURCE_FILE, gulp.series('copy-html', reload));


    watch(path.join(LIBS_SOURCE_DIR, '**/*'), gulp.series('copy-all-libs', reload));

});

// Default task
gulp.task('default', gulp.series('build', gulp.parallel('webserver', 'watch-changes')));
gulp.task('serve', gulp.series('build', 'webserver'));