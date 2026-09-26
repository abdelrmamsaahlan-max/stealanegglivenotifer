import test from "node:test";
import assert from "node:assert/strict";
import {
  parseScrambleBoss,
  scrambleEventKey
} from "../src/scramble-boss-tracker.js";

test("ignores Update 6 patch-note text", () => {
  const data = {
    text:
      "UPDATE 6 - DR. SCRAMBLE'S LABORATORY\n" +
      "Every 30 minutes, Dr. Scramble returns in his Mecha to take over the game!\n" +
      "Reach Tier 100 to unlock an OP Eternal.\n" +
      "There's also a SUPER RARE chance to obtain the newest Divine.\n" +
      "CHECK IT OUT NOW!",
    createdTimestamp: Date.now()
  };

  assert.equal(parseScrambleBoss(data), null);
});

test("detects a live Dr. Scramble boss spawn", () => {
  const now = Date.now();
  const event = parseScrambleBoss({
    text:
      "🤖 DR. SCRAMBLE IS HERE! He has returned in his Mecha. " +
      "Defeat Dr. Scramble to earn Samples. " +
      "Next boss fight in: (in 17 minutes)",
    createdTimestamp: now,
    linkUrls: ["https://www.roblox.com/games/107778070777162/Steal-An-Egg"]
  });

  assert.ok(event);
  assert.equal(event.type, "scramble_boss");
  assert.equal(event.cycleMinutes, 30);
  assert.equal(Math.round((event.nextBossAt - now) / 60000), 17);
  assert.equal(
    event.joinUrl,
    "https://www.roblox.com/games/107778070777162/Steal-An-Egg"
  );
});

test("deduplicates the same observed minute and join target", () => {
  const a = {
    appearedAt: 1780440000123,
    joinUrl: "https://www.roblox.com/games/107778070777162/Steal-An-Egg"
  };
  const b = {
    appearedAt: 1780440029999,
    joinUrl: "https://www.roblox.com/games/107778070777162/Steal-An-Egg?x=1"
  };

  assert.equal(scrambleEventKey(a), scrambleEventKey(b));
});
