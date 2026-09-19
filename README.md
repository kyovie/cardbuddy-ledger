# 牌友记账神器

面向朋友牌局的移动端记账工具。房间、玩家和账本均存储在 Cloud Firestore，所有设备通过实时监听同步；不再使用浏览器 P2P 或定时轮询。

## 本地运行

1. 安装依赖：`npm install`
2. 复制 `.env.example` 为 `.env.local`，填入 Firebase Web App 的公开配置。
3. 在 Firebase Console 启用 **Anonymous Authentication** 与 **Cloud Firestore**。
4. 启动：`npm run dev`

## 同步模型

- `rooms/{roomId}`：房间状态、底池、轮次和人数。
- `rooms/{roomId}/players/{uid}`：玩家身份与余额。
- `rooms/{roomId}/events/{operationId}`：不可变账本流水。
- 客户端对上述三类数据使用 `onSnapshot` 长连接监听。
- 每次转账、下注、弃牌、开局、推进轮次和结算均为 Firestore transaction。
- 每个命令使用 UUID 作为 `operationId`；重复发送不会重复扣款或重复记账。

## Firebase 发布

1. 用 Firebase Console 创建一个**新的**项目并注册 Web App。
2. 填写 `.env.local` 后执行 `npm run build`。
3. 登录并关联项目：`npx firebase login`、`npx firebase use --add`。
4. 先部署规则与索引：`npx firebase deploy --only firestore`。
5. 再部署网页：`npx firebase deploy --only hosting`。

`firebase.json` 已包含 SPA 路由、Firestore rules、索引和本地模拟器端口配置。

## 本地模拟器

执行 `npm run emulators` 启动 Auth/Firestore Emulator。Firebase Firestore Emulator 依赖 Java；本机没有 Java 时需先安装 JRE。模拟器仅用于本地验证，不会写入线上数据。
