#!/bin/bash

CONFIG_TMP="/tmp/.ncmp_install_tmp"

if [ -f "$CONFIG_TMP" ]; then
    source "$CONFIG_TMP"
fi

case "$1" in
    config)
        case "$2" in
            reset)
                rm -f .env
                rm -f "$CONFIG_TMP"
                touch .env
                echo "Config reset"
                ;;
            env)
                read -p "Service port port (default 3000): " express_port
                read -p "Service domain (e.g. https://ncmp.yourdomain.com): " express_domain
                read -p "Nextcloud URL (e.g. https://nextcloud.yourdomain.com): " nextcloud_url
                read -p "Nextcloud OAuth2 Client ID: " nextcloud_client_id
                read -sp "Nextcloud OAuth2 Client Secret: " nextcloud_client_secret
                echo ""

                express_port=${express_port:-3000}

                if [ -z "$express_domain" ]; then
                    echo "Error: Express domain is required."
                    exit 1
                fi
                if [ -z "$nextcloud_url" ]; then
                    echo "Error: Nextcloud URL is required."
                    exit 1
                fi
                if [ -z "$nextcloud_client_id" ]; then
                    echo "Error: Nextcloud Client ID is required."
                    exit 1
                fi
                if [ -z "$nextcloud_client_secret" ]; then
                    echo "Error: Nextcloud Client Secret is required."
                    exit 1
                fi

                cat > .env <<EOF
# EXPRESS
EXPRESS_PORT=$express_port
EXPRESS_PUBLIC_ROUTE=api/v1
EXPRESS_DOMAIN=$express_domain

# Nextcloud credentials
NEXTCLOUD_URL=$nextcloud_url
NEXTCLOUD_CLIENT_ID=$nextcloud_client_id
NEXTCLOUD_CLIENT_SECRET=$nextcloud_client_secret
EOF
                echo "Config saved to .env"
                rm -f "$CONFIG_TMP"
                ;;
            *)
                echo "Usage: $0 config {env|reset}"
                exit 1
                ;;
        esac
        ;;

    update)
        echo "Updating..."
        mv .env .env.bak
        find . -type f ! -name "*.bak" -delete
        rm -rf api express_utils client
        curl -L -o ncmp_app.zip https://github.com/st4lv/nextcloud-media-player/archive/refs/heads/main.zip
        unzip ncmp_app.zip -d ../
        rm ncmp_app.zip
        mv .env.bak .env
        chmod +x nextcloud-media-player.sh
        docker compose down
        docker container prune -f
        docker image prune -f
        docker build -t ncmp .
        echo "Updated successfully"
        ./nextcloud-media-player.sh start
        ;;

    start)
        echo "Starting..."
        docker compose up --detach
        ;;

    stop)
        echo "Stopping..."
        docker compose down
        ;;

    install)
        echo "Installing dependencies..."
        apt update
        apt-get install -y ca-certificates curl unzip
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
        chmod a+r /etc/apt/keyrings/docker.asc

        echo \
          "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
          $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
          tee /etc/apt/sources.list.d/docker.list > /dev/null
        apt-get update
        apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

        echo ""
        echo "Environment configuration"
        ./nextcloud-media-player.sh config env

        echo "Building NCMP..."
        docker build -t ncmp .
        ./nextcloud-media-player.sh start
        ;;

    *)
        echo "Usage: $0 {start|stop|install|update|config}"
        exit 1
        ;;
esac