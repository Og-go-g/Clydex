# Clydex — Plan

## Концепция
AI-агент для DeFi на Base chain. Чат-интерфейс где пользователь общается с AI на естественном языке, а агент анализирует yield, свапает токены и показывает портфолио.

## Архитектура

```
┌─────────────────────────────────────────────┐
│                 Frontend                     │
│  Next.js 15 + Tailwind + shadcn/ui          │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Chat UI  │  │ Sidebar  │  │ OnchainKit│  │
│  │ (main)   │  │ (history)│  │ Wallet    │  │
│  └──────────┘  └──────────┘  └───────────┘  │
│  OnchainKit (wallet, swap, earn, identity)   │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│              API Routes (Next.js)            │
│                                              │
│  /api/chat      — AI agent endpoint          │
│  /api/yields    — Yield data from DeFi Llama │
│  /api/portfolio — Wallet balances (viem)     │
│  /api/prices    — Token prices (DEX Screener)│
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│              AI Agent (Vercel AI SDK)        │
│                                              │
│  System prompt + Tool Calling               │
│  Tools:                                      │
│   - get_yields(protocol?, token?)            │
│   - get_swap_quote(from, to, amount)         │
│   - get_portfolio(address)                   │
│   - get_token_price(symbol)                  │
│   - execute_swap(from, to, amount)           │
└──────────────────┬──────────────────────────┘
                   │
            Base Chain (8453)
     Uniswap · Morpho · Aave · Aerodrome
```

## Страницы

1. `/` — Лендинг (hero + features + CTA)
2. `/chat` — Основной чат с AI агентом
3. `/yields` — Дашборд yield-стратегий на Base

## Ключевые фичи

### MVP (Неделя 1-2)
- [ ] Chat UI с AI агентом
- [ ] Подключение кошелька (OnchainKit)
- [ ] Yield Finder — "куда вложить 1 ETH?" → таблица лучших APY
- [ ] Swap Assistant — "обменяй ETH на USDC" → OnchainKit Swap компонент
- [ ] Portfolio View — "что у меня в кошельке?" → балансы + позиции
- [ ] Token Prices — "цена AERO?" → текущая цена + 24h change

### V2 (Неделя 3-4)
- [ ] Earn интеграция (Morpho vaults через OnchainKit Earn)
- [ ] История чатов (localStorage)
- [ ] Multi-step strategies
- [ ] Gas optimization recommendations
- [ ] Mobile responsive

## Стек технологий

### Frontend
- Next.js 15 (App Router)
- TypeScript
- Tailwind CSS + shadcn/ui
- OnchainKit (@coinbase/onchainkit) — wallet, swap, earn, identity

### AI
- Vercel AI SDK (streaming)
- OpenAI GPT-4o или Anthropic Claude (function calling)

### Data APIs (бесплатные, без ключей)
- DeFi Llama — yield/APY данные (бесплатный, без ключа)
- DEX Screener — token prices (бесплатный, без ключа)
- viem — on-chain balances, token reads (через RPC)

### Deploy
- Vercel (frontend + API routes)

## Структура файлов

```
clydex/
├── app/
│   ├── layout.tsx
│   ├── page.tsx              (landing)
│   ├── chat/
│   │   └── page.tsx          (main chat UI)
│   ├── yields/
│   │   └── page.tsx          (yield dashboard)
│   └── api/
│       ├── chat/
│       │   └── route.ts      (AI agent endpoint)
│       ├── yields/
│       │   └── route.ts      (DeFi Llama proxy)
│       ├── portfolio/
│       │   └── route.ts      (on-chain balances)
│       └── prices/
│           └── route.ts      (DEX Screener proxy)
├── components/
│   ├── chat/
│   │   ├── ChatWindow.tsx    (message list + input)
│   │   ├── Message.tsx       (single message bubble)
│   │   ├── ToolResult.tsx    (yield table, swap card, etc)
│   │   └── SwapCard.tsx      (OnchainKit swap embed)
│   ├── layout/
│   │   ├── Header.tsx
│   │   └── Sidebar.tsx
│   ├── yields/
│   │   └── YieldTable.tsx
│   └── ui/                   (shadcn components)
├── lib/
│   ├── ai/
│   │   ├── agent.ts          (system prompt + tools config)
│   │   └── tools.ts          (tool definitions)
│   ├── defi/
│   │   ├── yields.ts         (DeFi Llama client)
│   │   ├── prices.ts         (DEX Screener client)
│   │   ├── portfolio.ts      (viem balance reads)
│   │   └── constants.ts      (Base addresses, tokens)
│   └── onchain/
│       └── config.ts         (OnchainKit + wagmi config)
├── providers/
│   └── OnchainProvider.tsx   (OnchainKit wrapper)
├── public/
├── .env.local                (API keys)
├── .gitignore
├── package.json
├── tailwind.config.ts
└── tsconfig.json
```

## API Keys (нужны)
- `NEXT_PUBLIC_ONCHAINKIT_API_KEY` — CDP Client key (для OnchainKit)
- `OPENAI_API_KEY` — для AI агента (или ANTHROPIC_API_KEY)

## Порядок реализации

### Шаг 1: Scaffold + UI Shell
- Init Next.js 15 + Tailwind + shadcn
- OnchainKit provider setup
- Landing page
- Chat layout (sidebar + chat window)
- Header + wallet button

### Шаг 2: Data Layer
- DeFi Llama yields client
- DEX Screener prices client
- On-chain portfolio reader (viem)
- Base token constants

### Шаг 3: AI Agent
- System prompt с контекстом Base DeFi
- Tool definitions (function calling)
- /api/chat route с streaming
- Vercel AI SDK integration

### Шаг 4: Chat UI
- Message rendering (user + assistant)
- Tool result components (tables, cards)
- OnchainKit Swap embed
- Input with send button

### Шаг 5: Yield Dashboard
- /yields page с таблицей
- Filters по протоколу, токену
- Sort по APY, TVL

### Шаг 6: Polish + Deploy
- Error handling + loading states
- Dark theme
- Vercel deploy
