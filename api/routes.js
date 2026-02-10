const { Router } = require("express");
const router = Router();




const test_routes = require("./test/main");

router.use(`/test`, test_routes);
/*
const download_routes = require("./download/main");

router.use(`/download`, download_routes);

const files_routes = require("./files/main");

router.use(`/files`, files_routes);

const qrcode_routes = require("./qrcode/main");

router.use(`/qrcode`, qrcode_routes);
*/

router.get('/',async(req,res)=>{
    const pjson = require('../package.json');
    const json_body = {
        app: pjson.name,
        version : pjson.version,
        dev: pjson.author,
        license: pjson.license
    }
    return res.status(200).json({data:json_body})
})

module.exports = router;