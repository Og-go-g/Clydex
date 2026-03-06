import { streamText, tool, zodSchema, convertToModelMessages, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { getTokenPrice, getTopBaseTokens } from "@/lib/defi/prices";
import { searchYields, getBaseYields } from "@/lib/defi/yields";
import { getSwapQuote } from "@/lib/defi/swap";
import { getTokenBalance, formatUnits } from "@/lib/defi/utils";
import { TOKENS, OPENOCEAN } from "@/lib/defi/constants";

function getModel() {
  if (process.env.ANTHROPIC_API_KEY) {
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return anthropic("claude-sonnet-4-20250514");
  }
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai("gpt-4o");
}

const SYSTEM_PROMPT = `You are Clydex — an AI DeFi assistant for the Base blockchain (Coinbase L2).
You understand English and Russian equally well. Respond in the language the user writes in.

You help users:
- Check token prices on Base
- Find the best yield/APY opportunities across Base protocols
- Swap tokens on Base (ETH, USDC, WETH, AERO, cbETH)
- Understand DeFi concepts in simple terms

## General guidelines
- Always use tools to get real data before answering. Never make up prices or yields.
- Format numbers nicely: prices with $, APY with %, TVL in millions/thousands.
- Keep responses concise and actionable.
- When showing yields, highlight the top 3-5 opportunities.
- If user asks about portfolio/balances, direct them to the /portfolio page which shows multi-chain balances.
- Use markdown for formatting (bold, lists, etc).

## Swap handling — CRITICAL RULES (follow exactly)
When a user wants to swap tokens, ALWAYS call prepareSwap directly. Do NOT call getTokenPrice before swaps. Do NOT check wallet status. The prepareSwap tool handles everything including dollar-to-token conversion. The ONLY reason to ask the user before calling prepareSwap is if the token name is unrecognizable (see UNKNOWN TOKEN RULE below).

NEVER call getTokenPrice before prepareSwap. The prepareSwap tool has an amountUsd parameter that converts dollars to tokens automatically on the server.

### Step 1: Detect swap intent
If the user's message contains ANY of these patterns, it is a SWAP REQUEST — call prepareSwap:
- Any verb + token + "to/в/на/for/into/за" + token (e.g. "переведи 50 USDC в эфир", "move ETH to USDC")
- Keywords: swap, exchange, trade, convert, move, change, sell, buy, switch, turn into, get for
- Russian: свап, свапни, обменяй, обмен, поменяй, конвертируй, переведи, продай, купи, сменить
- Patterns: "X → Y", "X to Y", "X в Y", "X на Y", "X for Y", "X за Y"

### Step 2: Parse tokens and amount
Token aliases (case-insensitive):
- ETH / эфир / ether / эфириум = "ETH"
- USDC / юсдц / юсдс / усдц / усдс = "USDC"
- AERO / аэро = "AERO"
- WETH = "WETH", cbETH = "cbETH"

⚠️ UNKNOWN TOKEN RULE: If the user writes a token name/ticker that does NOT exactly match any alias above, DO NOT guess. Ask the user to clarify which token they meant. Examples of misspellings to ask about: "бсдс", "аэр", "усдт", "eth2", "юсдт". Never assume a misspelled token is one of the known tokens.

Direction: "X to/в/на/for Y" → fromToken=X, toToken=Y. "buy Y with X" → fromToken=X, toToken=Y.

### Step 3: Call prepareSwap with the right parameters
The prepareSwap tool accepts EITHER amount (token units) OR amountUsd (dollar value). Use the one that matches the user's intent:

A) **Token amount** (number WITHOUT $ sign): "swap 0.5 ETH", "переведи 50 USDC", "trade 100 AERO"
   → Call prepareSwap with amount="0.5" (token units). Do NOT call getTokenPrice.

B) **Dollar amount** ($ or "dollars"/"баксов"/"долларов"/"bucks"): "swap $5 in ETH", "обменяй 10$ эфира"
   → Call prepareSwap with amountUsd="5" (dollar value). The tool will convert to token amount automatically.

C) **Cents** ("cent"/"cents"/"цент"/"цента"/"центов"/"копеек"): "swap 73 cents of ETH", "свапни 50 центов эфира"
   → Pass the raw cent number to amountCents. Example: "84 cents" → amountCents="84". Do NOT convert to dollars yourself.

D) **"All" / "max" / "всё" / "all my" / "весь" / "все"**: Call prepareSwap with useMax=true. Do NOT ask for the exact amount — the tool fetches the wallet balance automatically.
   ⚠️ The ONLY token that cannot be swapped "all" is native ETH (because ETH pays for gas). For ALL other tokens (USDC, AERO, WETH, cbETH) "swap all" is perfectly fine — just call prepareSwap with useMax=true. The server handles the ETH restriction automatically, so ALWAYS call the tool and let it decide. NEVER warn about gas for non-ETH tokens.

### Number normalization
- Comma as decimal: "1,95" → "1.95"
- Comma as thousands: "1,000" → "1000" (3+ digits after comma = thousands separator)
- Space as thousands: "1 000" → "1000"

After prepareSwap returns, briefly mention the trade details in your text response.

### CRITICAL: Always call prepareSwap for every swap request
ALWAYS call prepareSwap for EVERY swap request, even if the same swap was requested before. Previous quotes expire instantly — never tell the user to "use the existing card" or "confirm the previous swap". Each swap request = a new prepareSwap call, no exceptions.`;

export async function POST(req: Request) {
  const { messages } = await req.json();
  if (!messages) {
    return new Response("Missing messages", { status: 400 });
  }
  const walletAddress = req.headers.get("x-wallet-address") || null;
  const modelMessages = await convertToModelMessages(messages);

  const result = streamText({
    model: getModel(),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    tools: {
      getTokenPrice: tool({
        description:
          "Get the current price of a token on Base chain. Use this when a user asks about token prices, market data, or says something like 'price of ETH' or 'how much is AERO'.",
        inputSchema: zodSchema(
          z.object({
            token: z
              .string()
              .describe(
                "Token symbol or name to look up, e.g. 'ETH', 'USDC', 'AERO', 'BRETT'"
              ),
          })
        ),
        execute: async ({ token }) => {
          const price = await getTokenPrice(token);
          if (!price) return { error: `Token "${token}" not found on Base` };
          return price;
        },
      }),

      getTopTokens: tool({
        description:
          "Get prices for the most popular tokens on Base. Use when user asks about 'top tokens', 'market overview', or 'what tokens are trending'.",
        inputSchema: zodSchema(z.object({})),
        execute: async () => {
          const tokens = await getTopBaseTokens();
          return { tokens };
        },
      }),

      searchYields: tool({
        description:
          "Search for DeFi yield opportunities on Base chain. Use when user asks about yields, APY, interest rates, or 'where to earn' on specific tokens.",
        inputSchema: zodSchema(
          z.object({
            query: z
              .string()
              .describe(
                "Search query — token symbol like 'USDC', 'ETH', or protocol name like 'aave', 'morpho', 'aerodrome'"
              ),
          })
        ),
        execute: async ({ query }) => {
          const pools = await searchYields(query);
          return {
            count: pools.length,
            pools: pools.slice(0, 10).map((p) => ({
              protocol: p.project,
              pair: p.symbol,
              apy: p.apy,
              apyBase: p.apyBase,
              apyReward: p.apyReward,
              tvl: p.tvlUsd,
            })),
          };
        },
      }),

      getTopYields: tool({
        description:
          "Get the highest yield opportunities across all Base DeFi protocols. Use when user asks for 'best yields', 'highest APY', or general yield farming overview.",
        inputSchema: zodSchema(z.object({})),
        execute: async () => {
          const pools = await getBaseYields();
          return {
            count: pools.length,
            top10: pools.slice(0, 10).map((p) => ({
              protocol: p.project,
              pair: p.symbol,
              apy: p.apy,
              apyBase: p.apyBase,
              apyReward: p.apyReward,
              tvl: p.tvlUsd,
            })),
          };
        },
      }),

      prepareSwap: tool({
        description:
          "Prepare a token swap on Base chain. Use when the user wants to swap, exchange, trade, convert, move, sell, or buy tokens. Trigger words: swap, exchange, trade, convert, move, change, sell, buy, switch, обменять, свап, поменять, конвертировать, перевести, продать, купить. Returns a quote for the user to confirm via SwapCard UI. Pass EITHER amount (token units) OR amountUsd (dollar value), not both.",
        inputSchema: zodSchema(
          z.object({
            fromToken: z
              .string()
              .describe("Token symbol to swap FROM (uppercase). e.g. 'USDC', 'ETH', 'AERO', 'WETH', 'cbETH'"),
            toToken: z
              .string()
              .describe("Token symbol to swap TO (uppercase). e.g. 'ETH', 'USDC', 'WETH', 'AERO', 'cbETH'"),
            amount: z
              .string()
              .optional()
              .describe("Amount in TOKEN units (e.g. '0.5', '100'). Use this when user specifies token amount like 'swap 0.5 ETH'."),
            amountUsd: z
              .string()
              .optional()
              .describe("Amount in US DOLLARS (e.g. '5', '10.50'). Use ONLY when user says dollars/$. Example: 'swap $5 of ETH' → amountUsd='5'."),
            amountCents: z
              .string()
              .optional()
              .describe("Amount in CENTS (e.g. '73', '50', '84'). Use ONLY when user says cents/цент/центов. Pass the raw number: '84 cents' → amountCents='84'. The server divides by 100 automatically."),
            useMax: z
              .boolean()
              .optional()
              .describe("Set to true when user wants to swap ALL / MAX / ВСЁ of a token. The server fetches the wallet balance automatically. Do NOT pass amount/amountUsd/amountCents when useMax=true."),
          })
        ),
        execute: async ({ fromToken, toToken, amount, amountUsd, amountCents, useMax }) => {
          if (!walletAddress) {
            return { error: "Please connect your wallet first to swap tokens." };
          }
          try {
            // --- useMax: fetch full wallet balance ---
            if (useMax) {
              const upper = fromToken.toUpperCase();
              const known = TOKENS[upper as keyof typeof TOKENS];
              if (!known) {
                return { error: `Unknown token "${fromToken}" for max balance lookup.` };
              }

              // Native ETH cannot be swapped "all" — need to keep ETH for gas
              if (!known.address) {
                return {
                  error: "Cannot swap all ETH — you need ETH to pay for gas fees. Please specify an exact amount instead (e.g. \"swap 0.01 ETH to USDC\").",
                };
              }

              const rawBalance = await getTokenBalance(known.address, walletAddress);

              if (rawBalance === "0") {
                return { error: `Your ${known.symbol} balance is 0. Nothing to swap.` };
              }

              const maxAmount = formatUnits(rawBalance, known.decimals);
              const quote = await getSwapQuote(fromToken, toToken, maxAmount, walletAddress);
              return { type: "swap_quote", ...quote, isMax: true };
            }

            // Normalize: treat "0", "", undefined as empty
            const hasAmount = amount && parseFloat(amount) > 0;
            const hasAmountUsd = amountUsd && parseFloat(amountUsd) > 0;
            const hasAmountCents = amountCents && parseFloat(amountCents) > 0;

            let tokenAmount: string | undefined;
            let usdDisplay: string | undefined;

            if (hasAmount) {
              // User specified token amount directly (e.g. "swap 0.5 ETH")
              tokenAmount = amount;
            } else if (hasAmountCents) {
              // User specified cents (e.g. "84 cents") — convert to dollars, then to tokens
              const dollars = parseFloat(amountCents!) / 100;
              const price = await getTokenPrice(fromToken);
              if (!price || !price.priceUsd) {
                return { error: `Could not get price for ${fromToken} to convert cent amount.` };
              }
              usdDisplay = `$${dollars.toFixed(2)}`;
              tokenAmount = String(dollars / price.priceUsd);
            } else if (hasAmountUsd) {
              // User specified dollars (e.g. "$5 of ETH") — convert to tokens
              const price = await getTokenPrice(fromToken);
              if (!price || !price.priceUsd) {
                return { error: `Could not get price for ${fromToken} to convert dollar amount.` };
              }
              const usdValue = parseFloat(amountUsd!);
              usdDisplay = `$${usdValue.toFixed(2)}`;
              tokenAmount = String(usdValue / price.priceUsd);
            }

            if (!tokenAmount) {
              return { error: "Please specify either a token amount or a dollar amount." };
            }

            const quote = await getSwapQuote(fromToken, toToken, tokenAmount, walletAddress);
            return { type: "swap_quote", ...quote, requestedUsd: usdDisplay || undefined };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Failed to get swap quote";
            return { error: message };
          }
        },
      }),
    },
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse();
}
