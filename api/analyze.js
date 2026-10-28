// Função serverless da Vercel: recebe um ticker, busca dados reais e pede a análise à IA.
const MODEL = process.env.MODEL || "claude-sonnet-5-5";

const SYSTEM = `Você é um assistente de educação financeira para investidores brasileiros.
Receberá dados de mercado de um ativo da B3 e deve explicar o cenário de forma didática.
Regras obrigatórias:
- Descreva o que os dados mostram: tendência recente, volatilidade, posição frente às máximas e mínimas, e principais riscos.
- NUNCA diga para comprar, vender ou manter. NUNCA dê preço-alvo, projeção de retorno ou promessa de ganho.
- Use apenas os dados fornecidos; se algo não estiver nos dados, diga que não sabe.
- Escreva em português do Brasil, em texto simples (sem markdown), em até 250 palavras.
- Termine com: "Conteúdo educacional baseado em dados públicos. Não é recomendação de investimento."`;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido." });

  const { ticker, code } = req.body || {};
  const codes = (process.env.ACCESS_CODES || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!codes.includes(String(code || "").trim())) {
    return res.status(401).json({ error: "Código de acesso inválido." });
  }

  const t = String(ticker || "").toUpperCase().trim();
  if (!/^[A-Z0-9]{4,6}$/.test(t)) return res.status(400).json({ error: "Ticker inválido. Exemplo: PETR4." });

  let q;
  try {
    const token = process.env.BRAPI_TOKEN ? `&token=${process.env.BRAPI_TOKEN}` : "";
    const r = await fetch(`https://brapi.dev/api/quote/${t}?range=3mo&interval=1d${token}`);
    const j = await r.json();
    q = j.results && j.results[0];
  } catch (e) { /* tratado abaixo */ }
  if (!q) return res.status(404).json({ error: "Não encontrei esse ativo (ou o limite da fonte de dados acabou)." });

  const closes = (q.historicalDataPrice || []).map(d => d.close).filter(Boolean);
  const ret3m = closes.length > 1 ? ((closes[closes.length - 1] / closes[0] - 1) * 100).toFixed(1) : null;
  const sma20 = closes.length >= 20 ? (closes.slice(-20).reduce((a, b) => a + b, 0) / 20).toFixed(2) : null;

  const dados = {
    ativo: q.symbol, nome: q.longName || q.shortName,
    preco: q.regularMarketPrice, variacao_dia_pct: q.regularMarketChangePercent,
    maxima_52s: q.fiftyTwoWeekHigh, minima_52s: q.fiftyTwoWeekLow,
    valor_de_mercado: q.marketCap, retorno_3_meses_pct: ret3m, media_20_dias: sma20,
  };

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 700, system: SYSTEM,
        messages: [{ role: "user", content: "Dados:\n" + JSON.stringify(dados, null, 2) }],
      }),
    });
    const j = await r.json();
    const text = (j.content || []).map(c => c.text || "").join("").trim();
    if (!text) return res.status(502).json({ error: "A IA não respondeu. Verifique a chave da API." });
    return res.status(200).json({ dados, analise: text });
  } catch (e) {
    return res.status(500).json({ error: "Erro ao falar com a IA." });
  }
};
