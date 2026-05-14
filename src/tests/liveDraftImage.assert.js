import assert from "node:assert/strict";
import { buildLiveDraftImageBuffer, getLiveDraftStripLayout } from "../utils/liveDraftImage.js";

async function runLiveDraftImageAssertions() {
  const layout = getLiveDraftStripLayout();
  assert.deepEqual(layout, {
    width: 618,
    height: 72,
    sideWidth: 272,
  });

  const imageBuffer = await buildLiveDraftImageBuffer({
    blueIconUrls: [null, undefined],
    redIconUrls: [],
  });

  assert.ok(Buffer.isBuffer(imageBuffer));
  assert.ok(imageBuffer.length > 0);

  const pngHeader = imageBuffer.subarray(0, 8);
  assert.deepEqual(Array.from(pngHeader), [137, 80, 78, 71, 13, 10, 26, 10]);
}

await runLiveDraftImageAssertions();
console.log("liveDraftImage assertions passed");
