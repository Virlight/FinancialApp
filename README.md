# Financial App AI Assistant MVP

一个最小 demo，用网页输入模拟语音文本，验证链路：

`用户输入 -> Gemini 结构化 JSON -> App 内部函数执行 -> 页面反馈`

## 支持的 App 动作

- `create_expense`: 记录一笔支出。
- `get_profile`: 查看 demo 用户 profile、余额、预算。
- `get_spending_summary`: 查看消费汇总。

## 启动和重启服务器

首次启动：

```bash
npm install
cp .env.example .env
npm run dev
```

打开 `http://localhost:3000`。

如果已经启动过服务，但页面没有显示最新代码或 `.env` 刚改过，需要重启服务器：

```bash
# 在正在运行 npm run dev 的终端里按 Ctrl+C 停止
npm run dev
```

如果找不到之前运行服务的终端，或者看到 `port 3000 already in use`，先查占用端口的进程：

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

然后停止对应的 PID：

```bash
kill <PID>
npm run dev
```

什么时候必须重启：

- 改了 `.env`，例如 `GEMINI_API_KEY` 或 `GEMINI_MODEL`。
- 当前页面还在使用 `mock`，但你确认 `.env` 已经有 Gemini key。
- 端口 3000 上跑的是旧进程。

什么时候不一定要重启：

- 只改了 `public/` 里的前端文件，通常刷新浏览器即可。
- 用 `npm run dev` 启动时，改 `src/` 后端文件通常会被 Node watch 自动重启。

如果没有配置 `GEMINI_API_KEY`，后端会自动使用本地 mock parser，方便先验证端到端链路。配置 Gemini 后，会使用 `@google/genai` 的 structured output 生成固定 JSON schema。

`.env` 示例：

```bash
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-2.5-flash
PORT=3000
```

## Debug 流程

页面每次执行都会展示完整链路：

```text
1. User Input
2. Prompt Sent To Gemini
3. Expected Model Output Contract
4. Raw Model Output
5. Normalized Intent JSON
6. App Function Call
```

也可以直接调接口查看同样的 debug 数据：

```bash
curl -s -X POST http://localhost:3000/api/assistant \
  -H 'Content-Type: application/json' \
  -d '{"message":"帮我记录一笔 12 欧的午饭支出"}'
```

## 示例输入

```text
帮我记录一笔 12 欧的午饭支出
查看我的 profile
这个月我花了多少？
```

## 测试

```bash
npm test
```
