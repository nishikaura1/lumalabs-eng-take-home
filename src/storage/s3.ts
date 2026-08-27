import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.js";

// Stand-in for the customer's "shared drive folder" step, which already
// works for them today. Swapping this for real Google Drive is a documented
// follow-up (see APPROACH.md, Scope Ledger) — not built now to keep the day
// focused on the loop that's actually broken (steps 3-4).
const client = new S3Client({ region: config.s3.region });

export async function uploadGeneratedImage(opts: {
  sku: string;
  variantIndex: number;
  bytes: Uint8Array;
  contentType?: string;
}): Promise<string> {
  const key = `generations/${opts.sku}/v${opts.variantIndex}-${Date.now()}.jpg`;
  await client.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: opts.bytes,
      ContentType: opts.contentType ?? "image/jpeg",
    }),
  );
  return key;
}

export async function signedUrlFor(key: string, expiresInSeconds = 3600): Promise<string> {
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}
