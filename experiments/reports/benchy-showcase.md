# Benchy Showcase — All Four OVC Instances

Artifact: 3DBenchy G-code, 6.726.610 bytes (6.41 MB), 173.351 lines

```text

================================================================================================
3DBenchy — 6.726.610 bytes (6.41 MB), 173.351 lines
Methodology: eth_estimateGas × chunk count + O(1) overhead. Chain params: Table 4. β = 1.5.
OVC-Access is O(1) (226.605 gas, constant across all chains and sizes).
OVC-Feature: f_claim = 402088064 (4020.88 mm net extrusion), derived from the artifact;
  slicer reports 3974.5 mm, the difference being start-G-code priming it excludes.
================================================================================================

Instance           Chain                 Chunks   Gas (Mgas)         Cost       Time
----------------------------------------------------------------------------------
OVC-Access         Ethereum (L1)           O(1)        0.227      $0.3399          —
OVC-Identity       Ethereum (L1)            470       5398.5       $8,098     2.35 h
OVC-Conformance    Ethereum (L1)            470        546.9      $820.32     2.35 h
OVC-Feature        Ethereum (L1)            470      12746.4      $19,120     2.35 h
WORST CASE (all 4) Ethereum (L1)            470      18692.0      $28,038     2.35 h
----------------------------------------------------------------------------------
OVC-Access         Arbitrum (L2)           O(1)        0.227      $0.0136          —
OVC-Identity       Arbitrum (L2)            506       5400.5      $324.03    3.2 min
OVC-Conformance    Arbitrum (L2)            506        588.8       $35.33    3.2 min
OVC-Feature        Arbitrum (L2)            506      12720.8      $763.25    3.2 min
WORST CASE (all 4) Arbitrum (L2)            506      18710.3       $1,123    3.2 min
----------------------------------------------------------------------------------
OVC-Access         opBNB (L2)              O(1)        0.227     $0.00014          —
OVC-Identity       opBNB (L2)                83       5423.2        $3.25    2.1 min
OVC-Conformance    opBNB (L2)                83         96.6      $0.0580    2.1 min
OVC-Feature        opBNB (L2)                83      13016.9        $7.81    2.1 min
WORST CASE (all 4) opBNB (L2)                83      18537.0       $11.12    2.1 min
----------------------------------------------------------------------------------
================================================================================================
```