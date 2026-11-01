import test from "node:test";
import assert from "node:assert/strict";
import { parseArchiveFile, parseTimestamp, validateArchive } from "../tick-archive.js";

const metadata={symbol:"XAUUSD",provider:"Example feed",sourceReference:"provider-export-2026-10",dataKind:"tick"};
const quotes=[
 {timestamp:"2026-10-31T09:00:00.000Z",bid:4000.1,ask:4000.2},
 {timestamp:"2026-10-31T09:00:00.100Z",bid:4000.11,ask:4000.21},
 {timestamp:"2026-10-31T09:00:00.250Z",bid:4000.12,ask:4000.22},
 {timestamp:"2026-10-31T09:00:00.500Z",bid:4000.13,ask:4000.23},
 {timestamp:"2026-10-31T09:00:01.000Z",bid:4000.14,ask:4000.24}
];

test("accepts provenance-labelled chronological Bid/Ask ticks and partitions by time",()=>{
 const result=validateArchive({metadata,quotes});
 assert.equal(result.ok,true);
 assert.equal(result.manifest.tickCount,5);
 assert.equal(result.manifest.partitions.train.tickCount,3);
 assert.equal(result.manifest.partitions.validation.tickCount,1);
 assert.equal(result.manifest.partitions.heldOutTest.tickCount,1);
 assert.equal(result.manifest.chronological,true);
 assert.ok(Math.abs(result.quotes[0].spread-0.1)<1e-9);
});

test("rejects duplicate and out-of-order timestamps",()=>{
 const duplicate=[...quotes,{...quotes[4]}];
 assert.equal(validateArchive({metadata,quotes:duplicate}).ok,false);
 const outOfOrder=[quotes[0],quotes[2],quotes[1]];
 assert.equal(validateArchive({metadata,quotes:outOfOrder}).ok,false);
});

test("rejects crossed prices, mixed symbols and OHLC metadata",()=>{
 assert.equal(validateArchive({metadata,quotes:[quotes[0],{...quotes[1],ask:quotes[1].bid}]}).ok,false);
 assert.equal(validateArchive({metadata,quotes:[quotes[0],{...quotes[1],symbol:"XAGUSD"}]}).ok,false);
 assert.equal(validateArchive({metadata:{...metadata,dataKind:"ohlc"},quotes}).ok,false);
});

test("requires timezone-explicit, calendar-valid timestamps",()=>{
 assert.ok(Number.isNaN(parseTimestamp("2026-10-31T09:00:00")));
 assert.ok(Number.isNaN(parseTimestamp("2026-02-30T09:00:00Z")));
 assert.ok(Number.isFinite(parseTimestamp("2026-10-31T09:00:00+01:00")));
});

test("imports strict CSV with timestamp,bid,ask columns",()=>{
 const csv="timestamp,bid,ask\n2026-10-31T09:00:00Z,4000.1,4000.2\n2026-10-31T09:00:01Z,4000.2,4000.3";
 const result=parseArchiveFile({name:"sample.csv",text:csv,metadata});
 assert.equal(result.ok,true);
 assert.equal(result.manifest.tickCount,2);
});

test("rejects malformed CSV and missing provenance",()=>{
 const bad=parseArchiveFile({name:"bad.csv",text:'timestamp,bid,ask\n2026-10-31T09:00:00Z,"4000.1,4000.2\n2026-10-31T09:00:01Z,4000.2,4000.3',metadata});
 assert.equal(bad.ok,false);
 assert.equal(validateArchive({metadata:{...metadata,provider:""},quotes}).ok,false);
});
