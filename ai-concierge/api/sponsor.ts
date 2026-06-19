export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { txBytes, sender } = req.body;

  if (!txBytes || !sender) {
    return res.status(400).json({ error: 'Missing txBytes or sender' });
  }

  const SHINAMI_GAS_KEY = process.env.SHINAMI_GAS_KEY;

  if (!SHINAMI_GAS_KEY) {
    return res.status(500).json({ error: 'Server configuration error: SHINAMI_GAS_KEY missing' });
  }

  try {
    const response = await fetch('https://api.shinami.com/gas/v1/sui_testnet', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': SHINAMI_GAS_KEY.trim(),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'gas_sponsorTransactionBlock',
        params: [txBytes, sender, 10000000],
      }),
    });

    let data;
    const responseText = await response.text();
    
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Shinami returned non-JSON response:', responseText);
      return res.status(500).json({ error: `Shinami API failed: ${response.status} ${responseText}` });
    }

    if (data.error) {
      console.error('Shinami returned JSON error:', data.error);
      return res.status(500).json({ error: data.error.message || 'Failed to sponsor transaction' });
    }

    return res.status(200).json(data.result);
  } catch (error) {
    console.error('Sponsor error:', error);
    return res.status(500).json({ error: `Internal server error: ${(error as any).message}` });
  }
}
