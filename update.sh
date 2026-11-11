#!/usr/bin/env bash
set -e

# ==========================================
# edgetunnel 一键更新与部署脚本
# ==========================================

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}====================================================${NC}"
echo -e "${GREEN}🚀 edgetunnel 一键自动更新与重启脚本${NC}"
echo -e "${BLUE}====================================================${NC}"

# 1. 确保在正确的项目目录中
if [ ! -f "server.mjs" ]; then
    if [ -d "edgetunnel" ]; then
        cd edgetunnel
    elif [ -d "/home/ecs-user/edgetunnel" ]; then
        cd /home/ecs-user/edgetunnel
    fi
fi

if [ ! -f "server.mjs" ]; then
    echo -e "${RED}❌ 未找到 edgetunnel 项目目录，请在项目根目录运行此脚本！${NC}"
    exit 1
fi

echo -e "${YELLOW}📥 正在拉取最新代码...${NC}"
# 优先使用 ghfast 国内加速代理拉取，若失败则尝试官方直连或单文件拉取
if git pull https://ghfast.top/https://github.com/sun459834451-eng/edgetunnel.git main; then
    echo -e "${GREEN}✅ 代码拉取成功！${NC}"
elif git pull origin main; then
    echo -e "${GREEN}✅ 代码拉取成功！${NC}"
else
    echo -e "${YELLOW}⚠️ Git pull 失败，尝试单文件直拉覆盖...${NC}"
    curl -sSL -o server.mjs https://ghfast.top/https://raw.githubusercontent.com/sun459834451-eng/edgetunnel/main/server.mjs
    curl -sSL -o _worker.js https://ghfast.top/https://raw.githubusercontent.com/sun459834451-eng/edgetunnel/main/_worker.js
    echo -e "${GREEN}✅ 核心文件更新成功！${NC}"
fi

# 2. 检查 .env 配置文件
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    echo -e "${YELLOW}⚙️ 未检测到 .env 配置文件，正在创建默认配置...${NC}"
    cp .env.example .env
fi

# 3. 停止并清理旧容器
echo -e "${YELLOW}🛑 正在清理旧容器...${NC}"
docker stop edgetunnel 2>/dev/null || true
docker rm edgetunnel 2>/dev/null || true

# 4. 重新构建 Docker 镜像
echo -e "${YELLOW}🔨 正在重新构建 Docker 镜像...${NC}"
docker build -t edgetunnel .

# 5. 启动新容器
echo -e "${YELLOW}🚀 正在启动新容器...${NC}"
mkdir -p data
if [ -f ".env" ]; then
    docker run -d \
        --name edgetunnel \
        --restart unless-stopped \
        -p 8080:8080 \
        -v "$(pwd)/data:/app/data" \
        --env-file .env \
        edgetunnel
else
    docker run -d \
        --name edgetunnel \
        --restart unless-stopped \
        -p 8080:8080 \
        -v "$(pwd)/data:/app/data" \
        edgetunnel
fi

sleep 2

# 6. 检查运行状态
if docker ps | grep -q edgetunnel; then
    SERVER_IP=$(curl -s4 --connect-timeout 3 ifconfig.me 2>/dev/null || curl -s4 --connect-timeout 3 icanhazip.com 2>/dev/null || echo "127.0.0.1")
    echo -e "${BLUE}====================================================${NC}"
    echo -e "${GREEN}🎉 edgetunnel 部署更新成功并已就绪！${NC}"
    echo -e "${BLUE}====================================================${NC}"
    echo -e "📡 运行状态: ${GREEN}运行中 (Running)${NC}"
    echo -e "🌐 管理面板: ${YELLOW}http://${SERVER_IP}:8080/admin${NC}"
    echo -e "📋 查看日志: ${BLUE}docker logs -f edgetunnel${NC}"
    echo -e "${BLUE}====================================================${NC}"
else
    echo -e "${RED}❌ 容器启动失败，请运行以下命令查看日志排查：${NC}"
    echo "docker logs edgetunnel"
fi
