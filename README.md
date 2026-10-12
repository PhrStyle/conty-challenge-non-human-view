# Conty. Views que não parecem humanas

API que recebe uma série de views por hora e devolve uma classificação explicável (`organico`, `inconclusivo` ou `suspeito`), um motivo legível, os sinais usados e cada evento encontrado na série. Não há modelo treinado: são cinco sinais com limites fixos, descritos abaixo. Stack: Node 22, TypeScript estrito, Hono, Vitest.

```bash
npm install
npm test
npm run typecheck
npm run evaluate                  # gera data/dataset.jsonl e calcula a taxa de falso positivo
npm run evaluate -- --write-readme  # o mesmo, e reescreve o bloco de avaliação deste README
npm run dev                       # http://127.0.0.1:3005 (`PORT` muda a porta)
```

## API

`POST /classify` com `{"views": [210, 180, 95, ...]}`: uma posição por hora, com as views **daquela hora** (não acumuladas). Inteiros ≥ 0, até 2160 horas (90 dias). A série não traz data nem fuso: "hora 30" é a posição 30, e o "dia" é contado a partir da hora 0.

| Resposta | Quando |
| --- | --- |
| `200` | sempre que a entrada é válida, inclusive série curta (vem `inconclusivo`) |
| `422 validation` | corpo sem `views`, valor negativo, fracionado, texto ou série longa demais |

Exemplo (base ~200 views/h e um bloco de ~10.000 views/h por 6 horas). A resposta abaixo veio de uma execução real, com o campo `events` encurtado:

```json
{
  "classification": "suspeito",
  "reason": "Suspeito. Pico de 10.050 views/h nas horas 30 a 35 (dia 2), sobre uma base de ~200: saltou de 297 para 10.010 views/h em uma hora (33,7x) na hora 30, sem subida gradual; ficou 6h seguidas entre 9.980 e 10.050 views/h nas horas 30 a 35, sem variar mais de 0,7% em 5h, quando audiência real oscila; caiu de 10.020 para 200 views/h em uma hora na hora 36 (-98%). Audiência real não mostra esses sinais juntos.",
  "signals": [
    { "id": "degrau", "label": "Subida em degrau", "hour": 30, "detail": "saltou de 297 para 10.010 views/h em uma hora (33,7x) na hora 30, sem subida gradual" },
    { "id": "plato", "label": "Platô", "hour": 30, "detail": "ficou 6h seguidas entre 9.980 e 10.050 views/h nas horas 30 a 35, sem variar mais de 0,7% em 5h, quando audiência real oscila" },
    { "id": "queda_abrupta", "label": "Queda abrupta", "hour": 36, "detail": "caiu de 10.020 para 200 views/h em uma hora na hora 36 (-98%)" }
  ],
  "events": [
    { "kind": "pico", "start_hour": 30, "end_hour": 35, "day": 2, "peak": 10050, "baseline": 200, "classification": "suspeito", "signals": ["…"], "reason": "…" }
  ],
  "hours": 72
}
```

`signals` traz só os sinais que sustentam a classificação geral. `events` traz tudo o que foi encontrado, inclusive picos orgânicos, cada um com a própria classe e o próprio motivo.

## Critério

Todos os limites estão num único objeto, `CRITERIA`, em [`src/classifier.ts`](src/classifier.ts).

**Base e pico.** A base é a mediana das últimas 24 horas que não estavam em pico. Uma hora entra em pico quando passa de 3x a base **e** de base + 300 views. O pico vai até as views voltarem abaixo desse limite, e a base fica congelada enquanto ele dura.

**Sinais de um pico:**

| Sinal | Dispara quando | Por quê |
| --- | --- | --- |
| Subida em degrau | uma hora tem 4x a anterior e já chega a 70% do pico | audiência real sobe em rampa; compra entra cheia na primeira hora |
| Platô | 5h ou mais em que toda janela de 5h varia no máximo 5% | audiência real oscila hora a hora; bot entrega o volume contratado |
| Queda abrupta | perde 75% ou mais em uma hora, partindo de pelo menos metade do pico | audiência real decai aos poucos; compra acaba de uma vez |
| Sem ciclo de dia e noite | o platô ou a repetição dura 24h ou mais | público real assiste menos de madrugada |
| Fora do horário do público | o pico começa numa das 6 horas do dia com menos audiência no ciclo do próprio criador | só **reforça** um pico que já tem outro sinal (veja abaixo) |

**Fora de pico:** 6h ou mais com a mesma regra do platô (média ≥ 50 views/h) geram um evento de **repetição mecânica**, que também ganha "sem ciclo de dia e noite" se durar 24h.

**Horário do público.** Para cada hora do dia (posição módulo 24) calcula-se a mediana das views, sem os picos e sem as 12h seguintes a cada pico, já que a cauda de um post infla as horas depois dele. As 6 horas com menor mediana são a "madrugada" daquele criador. O sinal só é usado se o ciclo é claro: as 24 horas têm dado e a hora mais ativa tem pelo menos 1,5x a menos ativa. Quem posta o dia inteiro pode não ter hora limpa, e aí o sinal simplesmente não é usado.

**Classificação:**

1. Série com menos de 48h: `inconclusivo`, sem análise. Não há base antes do pico nem dois ciclos de dia e noite.
2. Algum evento com **2 sinais ou mais**: `suspeito`.
3. **Recorrência em intervalo fixo:** 3 eventos de um sinal só, separados pelo mesmo intervalo (24h e 24h, 48h e 48h…; tolerância de 3h, intervalo de pelo menos 12h): `suspeito`. Uma vez pode ser o algoritmo; no mesmo ritmo parece entrega programada.
4. Algum evento com 1 sinal: `inconclusivo`. Inclui vários eventos isolados sem intervalo fixo entre eles.
5. Nenhum sinal: `organico`.

### Pico orgânico x pico comprado

O teste [`test/classifier.test.ts`](test/classifier.test.ts) coloca, sobre a mesma audiência, um viral de 10.000 views/h que sobe em 4h e perde metade a cada 12h, e um bloco comprado de 10.000 views/h por 6h. O viral sai `organico`, sem sinais. O comprado sai `suspeito`, com degrau, platô e queda abrupta.

### Quando o classificador prefere não acusar

Um viral que some de uma hora para outra, por ter sido arquivado ou cortado pelo algoritmo da plataforma, tem só a queda abrupta. Sai `inconclusivo`, com o motivo "Um sinal sozinho não basta para acusar: pode ser o algoritmo da plataforma, vídeo arquivado ou um compartilhamento grande." O mesmo vale para o viral que chega ao pico em 1h porque um perfil grande compartilhou (só degrau), desde que comece com o público do criador acordado.

## Dataset sintético e taxa de falso positivo

[`src/dataset.ts`](src/dataset.ts) gera as séries com um PRNG de semente fixa (mulberry32), sem rede e sem dado real. A audiência é uma contagem de Poisson sobre um ciclo senoidal de dia e noite, com ~15% de oscilação hora a hora. O bot entrega o volume contratado com ~1% de variação. Premissa: post legítimo começa com o público ativo (metade ativa do ciclo do criador). A exceção é `viral_compartilhado`, que pode começar a qualquer hora para medir o risco do sinal de horário. O arquivo [`data/dataset.jsonl`](data/dataset.jsonl) é a saída do gerador, e um teste falha se ele divergir.

**Falso positivo** = série legítima classificada como `suspeito`. `inconclusivo` não acusa, então não conta como falso positivo, mas aparece separado.

<!-- avaliacao:inicio (gerado por npm run evaluate, não editar à mão) -->
Semente 20261012, 40 séries de 168h por categoria, 480 séries no total.

**Taxa de falso positivo: 13,2%** (37 de 280 séries legítimas classificadas como `suspeito`).

- Legítimas marcadas como `inconclusivo` (sem acusação): 109 de 280 (38,9%).
- Suspeitas detectadas como `suspeito`: 164 de 200 (82,0%); `inconclusivo`: 1; passaram como `organico`: 35.

| Categoria | Rótulo | Difícil | O que simula | organico | inconclusivo | suspeito |
| --- | --- | --- | --- | ---: | ---: | ---: |
| `estavel` | legitimo | não | audiência constante com ciclo de dia e noite | 40 | 0 | 0 |
| `viral_organico` | legitimo | não | viraliza: sobe em 3 a 6h até 15-60x a base e decai devagar (meia-vida de 8 a 24h) | 40 | 0 | 0 |
| `viral_compartilhado` | legitimo | sim | perfil grande compartilha: o pico chega em 1h (degrau), em qualquer hora do dia, e decai devagar | 18 | 20 | 2 |
| `viral_interrompido` | legitimo | sim | viraliza e é arquivado ou perde alcance no algoritmo: as views caem para 5-20% de uma hora para outra | 25 | 15 | 0 |
| `criador_pequeno` | legitimo | sim | 2 a 15 views/h, muitas horas zeradas e 2 a 4 posts que sobem em 1-2h e somem em poucas horas | 1 | 36 | 3 |
| `postador_diario` | legitimo | sim | posta todo dia no mesmo horário, com o público ativo: cada post sobe em 1 a 3h até 4-12x a base | 10 | 27 | 3 |
| `postador_diario_instantaneo` | legitimo | sim | posta todo dia no mesmo horário, com o público ativo, e cada post chega ao pico na 1ª hora: só com views, igual a `gotas_diarias` | 0 | 11 | 29 |
| `pico_comprado` | suspeito | não | bloco de 3 a 10h com 10-80x a base, entregue quase constante, que começa e termina de uma vez | 0 | 0 | 40 |
| `compra_sobre_viral` | suspeito | não | viral orgânico com um bloco comprado de 4-8x o volume do momento, enxertado na descida | 0 | 0 | 40 |
| `repeticao_mecanica` | suspeito | não | conta pequena com fluxo de bot quase constante (30-100x a base, mínimo 500 views/h) por 36h ou mais | 0 | 0 | 40 |
| `gotas_diarias` | suspeito | não | 3 a 5 dias seguidos com um empurrão no mesmo horário: chega de uma vez a 8-25x a base e decai rápido | 0 | 0 | 40 |
| `compra_disfarcada` | suspeito | sim | compra que imita viral: sobe em 3 a 5h e decai devagar, sem platô nem queda brusca | 35 | 1 | 4 |
<!-- avaliacao:fim -->

**Como ler.** Quase todo o falso positivo vem de `postador_diario_instantaneo`, uma categoria incluída de propósito para mostrar o limite do critério. Um criador que posta todo dia no mesmo horário e explode na 1ª hora é, olhando só as views, idêntico a uma compra diária agendada, e a regra de recorrência o acusa. A taxa depende da mistura de categorias do dataset: ela mede este conjunto, não o mundo real. O teste [`test/dataset.test.ts`](test/dataset.test.ts) falha se a taxa ou o bloco acima divergirem do que o comando mede.

## O que o critério não detecta (ou erra)

- **Compra disfarçada de viral:** bot que sobe em rampa e decai devagar, sem platô nem queda brusca, passa na maioria das vezes como `organico` (categoria `compra_disfarcada` na tabela).
- **Compra pequena perto do orgânico:** um bloco comprado sobre um viral grande pode não causar queda de 75% ao terminar, nem formar platô, porque o orgânico embaixo varia. Fica com um sinal só.
- **Bot fraco:** fluxo constante abaixo de ~50 views/h, ou pico que não passa de base + 300 views, não é avaliado.
- **Postador regular com estreia instantânea:** é acusado pela recorrência (acima). Só com views não dá para separar de compra agendada.
- **Coincidência de ritmo:** posts em horas aleatórias podem cair por acaso em intervalos quase iguais (ex.: horas 98, 113 e 125) e serem acusados.
- **Viral compartilhado de madrugada:** degrau no horário de menor audiência do criador soma 2 sinais e vira `suspeito`. Também o viral cuja descida é compensada pela subida do dia e fica plano por 5h, o que parece platô.
- **Queda sem pico:** perda de alcance a partir do nível normal (shadowban) não é um pico e não gera sinal.
- **Sem dados além de views:** curtidas, comentários, retenção, origem do tráfego e fuso horário real ficam fora. Os limites foram escolhidos por raciocínio sobre a forma das curvas, não otimizados contra o dataset.

## IA

- **Feito com IA:** Claude Code (Opus 5.5) escreveu o código, os testes, o gerador de dataset e este README a partir do enunciado, seguindo a stack dos meus projetos anteriores (Hono + Vitest). A IA propôs o desenho dos sinais e os limites numéricos de `CRITERIA`.
- **Ferramentas usadas na execução:** a IA rodou `npm test`, `npm run typecheck`, `npm run evaluate` e `curl` contra a API local; o exemplo de resposta acima vem dessa execução.
- **Revisado por mim:** a IA me consultou em cada ponto que o enunciado não definia, com exemplos de séries, e eu decidi:
  - **Três classes, com registro por evento:** `organico`, `suspeito` e `inconclusivo`. A resposta traz a classe geral e cada evento encontrado, com a própria classe e o próprio motivo.
  - **Só acusa com 2 sinais ou mais no mesmo evento.** Um sinal só é `inconclusivo`, porque contas que não mantêm frequência ou que citam conteúdo problemático podem ser freadas pelo algoritmo, e isso gera quedas e saltos sem compra nenhuma.
  - **Um pico comprado claro, mesmo que único, é `suspeito`.**
  - **Recorrência por período consistente, não por dia de calendário:** a IA propôs contar dias do calendário da série (que acusava posts com 10h de diferença como "dias seguidos") e depois um intervalo fixo de 24h. Eu defini que vale qualquer intervalo consistente (24h e 24h, 48h e 48h…). Ocorrências espaçadas sem ritmo ficam `inconclusivo`.
  - **Consistência explicável x pico inconsistente:** desempenho consistente em horários de público é normal; pico fora do padrão não é. Daí veio o sinal "fora do horário do público", que reforça um pico que já tem outro sinal. Mantive a recorrência acusando mesmo no horário ativo, sabendo que isso pega o postador regular com estreia instantânea.
  - **Série com menos de 48h é `inconclusivo`, não erro.**
  - **Dataset com casos legítimos difíceis**, inclusive uma categoria que o critério sabidamente erra (`postador_diario_instantaneo`), para que a taxa de falso positivo mostre o limite em vez de um 0% conveniente.
- **Ajustes feitos pela IA durante a medição e mostrados a mim:** platô e repetição medidos por janelas de 5h (um fluxo de 30h se quebrava em pedaços), fluxo mínimo de bot de 500 views/h na categoria óbvia (perto de 300 o pico ligava e desligava), exclusão da cauda de 12h dos picos no perfil do dia (a cauda dos posts diários fazia a hora do post parecer madrugada) e posts legítimos no horário ativo do criador.
