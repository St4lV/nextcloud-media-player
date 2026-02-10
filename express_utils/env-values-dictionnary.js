require('dotenv').config();

// Values from .env file

const express_values = {
    port : process.env.EXPRESS_PORT,
    public_route : process.env.EXPRESS_PUBLIC_ROUTE,
	domain : process.env.EXPRESS_DOMAIN,
}

const nextcloud_values = {
	url :process.env.NEXTCLOUD_URL,
	client_id: process.env.NEXTCLOUD_CLIENT_ID,
	client_secret: process.env.NEXTCLOUD_CLIENT_SECRET,
}

module.exports = { express_values, nextcloud_values }