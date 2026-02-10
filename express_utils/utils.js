function URLize(input){
  return input.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_")
}

const pjson = require('../package.json');
const log = {
    data(data){
      console.log(`[${pjson.name}@${pjson.version}] `+data)
    },
    error(data){
      console.error(`[${pjson.name}@${pjson.version}] `+data)
    }
}

const cron = require('node-cron');
let app_updating = false;

async function cronTasks(){
  	app_updating = true;

	

    app_updating = false;
}

async function cronCommand(schedule = "0 4 * * *", callback) {
	// Default run everyday at 4h,
    // https://crontab.guru/#0_4_*_*_*

    try {
        const task = cron.schedule(schedule, async () => {
            try {
                await callback();
            } catch (err) {
                log.error(err);
            }
        });
        return { code: 200, data: "Success", task };
    } catch (err) {
        return { code: 500, data: err };
    }
}

// Text formatting code coming from dotenv lib

function supportsAnsi () {
  return process.stdout.isTTY // && process.env.TERM !== 'dumb'
}
function dim (text) {
  return supportsAnsi() ? `\x1b[2m${text}\x1b[0m` : text
}


module.exports = { URLize, log, app_updating, cronTasks, dim, };