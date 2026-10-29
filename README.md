# Marketplace FIPE Lens

Protótipo de extensão Chrome para comparar anúncios de motos do Facebook Marketplace com a tabela FIPE e destacar fatores visíveis no anúncio.

## Instalar a extensão

Instale o Playwright e o Chromium headless uma vez:

```powershell
python -m pip install -r requirements.txt
python -m playwright install chromium
```

1. Abra `chrome://extensions` e ative **Modo do desenvolvedor**.
2. Clique em **Carregar sem compactação** e selecione `E:\Projetos\marketplace\extension`.
3. No PowerShell, execute `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` se necessário e `E:\Projetos\marketplace\install_native_host.ps1`.
4. Recarregue a extensão. Ao enfileirar anúncios de uma busca de motos, ela inicia o worker headless automaticamente. Mapeamentos confirmados ficam salvos por 30 dias.

O worker usa até duas páginas simultâneas e espera três segundos entre navegações. Se o Facebook indicar bloqueio, ele pausa a fila; o intervalo reduz a frequência, mas não garante acesso contínuo. O Native Messaging host do Chrome inicia o worker local sob demanda.

O destaque inicial começa em 15% abaixo da FIPE. Os dados da FIPE são consultados em `parallelum.com.br` e ficam em cache local por 30 dias. A descrição e os anúncios ficam salvos localmente. A extensão não envia a descrição a um serviço de IA: mostra regras/sinais explícitos, como revisão, quilometragem, problemas mecânicos ou alerta documental.

Marca, modelo, cilindrada e ano são resolvidos com os dados da página de detalhes e o catálogo FIPE de motos. Se a versão ficar ambígua ou incompleta, a extensão não mostra uma cotação. Preço abaixo da FIPE é apenas um sinal; não avalia estado mecânico, documentação nem risco de fraude.

## Script de captura em JSON

O arquivo `marketplace_search.py` abre uma busca com Playwright e salva os cartões visíveis. Instalação:

```powershell
python -m pip install -r requirements.txt
python -m playwright install chromium
```

Execução:

```powershell
python marketplace_search.py
```

Por padrão, coleta a busca Ninja 250 usada na validação e grava `marketplace_results.json`. Para outra busca:

```powershell
python marketplace_search.py --url "https://www.facebook.com/marketplace/.../search/?query=..." --output dados/resultados.json
```

## Validação anterior

Em 28/10/2026, a busca fornecida exibiu 22 cartões no Chromium sem login; os resultados estão em `marketplace_results.json`. A captura tinha 19 títulos com “Ninja” e mediana simples de R$ 17.000. Alguns anúncios eram correlatos; filtre pelo modelo antes de analisar.

Os repositórios `ai-marketplace-monitor` e `facebook-marketplace-scraper` estão ao lado como referências avaliadas; o primeiro exige login no Facebook e o segundo está arquivado e limitado a cidades dos EUA.
