const express = require('express');
const fileUpload = require("express-fileupload");

const { express_values } = require("./express_utils/env-values-dictionnary");
const { log, cronTasks, dim } = require("./express_utils/utils")

const app = express();
const port = express_values.port;

app.use(express.json());
app.use(fileUpload({
	defParamCharset: 'utf8',
}));

app.set('trust proxy', true);

// Routes declarations
///////////////////////////////////////////////////////////////////////

const api_routes = require("./api/routes");
app.use(`/${express_values.public_route}`, api_routes);

app.get('/main.js', async (req, res) => {
	return res.status(200).sendFile('main.js', { root: __dirname + "/client/" });
});
app.get('/styles.css', async (req, res) => {
	return res.status(200).sendFile('styles.css', { root: __dirname + "/client/" });
});
app.get('/favicon.ico', async (req, res) => {
	return res.status(200).sendFile('favicon.ico', { root: __dirname + "/client/" });
});

app.get('/manifest.json', async (req, res) => {
	return res.status(200).sendFile('manifest.json', { root: __dirname + "/client/" });
});

app.get('/sw.js', async (req, res) => {
	return res.status(200).sendFile('sw.js', { root: __dirname + "/client/" });
});

app.get('/', async (req, res) => {
	return res.status(200).sendFile('index.html', { root: __dirname + "/client/" });
});

// Setup and start
///////////////////////////////////////////////////////////////////////

appSetup();

app.listen(port, async () => {
	log.data(`=============================================`);
	log.data(`Running app on port ${port}`);
	log.data(`=============================================`);
	/*log.data(`Access your files with SFTP on host : ${dim("- /var/online-media-converter-main/downloaded")}`);
	log.data(`This project can run thanks to yt-dlp${dim(" - https://github.com/yt-dlp/yt-dlp")}`)*/
});

async function appSetup() {
	log.data("Setting up cron jobs..");
	cronTasks();
	log.data("Cron tasks updated.")
}