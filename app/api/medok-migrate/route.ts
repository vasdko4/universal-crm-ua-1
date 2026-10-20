// TEMPORARY one-shot migration route for the Med-OK transfer (schema apply +
// WooCommerce catalog import into Vercel Blob + Neon). DELETE AFTER USE.
import { NextRequest, NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { put } from '@vercel/blob'
import { pool } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// One-time secret — rotate after the migration, then delete this route.
const KEY = 'b9WxLEiCwH07pmzonihzINl3W9g3cQG6'
const WC = 'https://med-ok.kiev.ua/wp-json/wc/store/v1'

function stripHtml(s: string | undefined): string {
  return (s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function blobName(wcId: number, idx: number, src: string): string {
  const m = /\.([a-z]{3,4})(?:\?|$)/i.exec(src)
  const ext = (m?.[1] ?? 'jpg').toLowerCase().replace(/[^a-z]/g, '') || 'jpg'
  return `medok/p-${wcId}-${idx}.${ext}`
}

async function opSchema() {
  const client = await pool.connect()
  try {
    const schema = readFileSync(join(process.cwd(), 'db', 'schema.sql'), 'utf8')
    if (schema.trim()) await client.query(schema)
    const migrate = readFileSync(join(process.cwd(), 'db', 'migrate.sql'), 'utf8')
    if (migrate.trim()) await client.query(migrate)
    const c = await client.query(
      `SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_schema='public'`,
    )
    return { ok: true, op: 'schema', tables: c.rows[0].c }
  } finally {
    client.release()
  }
}

type WcCat = { id: number; name: string; slug: string; parent: number }

async function opCategories() {
  const res = await fetch(`${WC}/products/categories?per_page=100`)
  if (!res.ok) throw new Error(`wc categories http ${res.status}`)
  const cats = (await res.json()) as WcCat[]
  const sorted = [...cats].sort((a, b) => (a.parent === 0 ? 0 : 1) - (b.parent === 0 ? 0 : 1))
  const existing = await pool.query(`SELECT id, slug FROM categories`)
  const slugToId = new Map<string, number>()
  const usedSlugs = new Set<string>()
  for (const r of existing.rows) {
    slugToId.set(r.slug, r.id)
    usedSlugs.add(r.slug)
  }
  const map = new Map<number, number>()
  let created = 0
  for (const c of sorted) {
    if (slugToId.has(c.slug)) {
      map.set(c.id, slugToId.get(c.slug)!)
      continue
    }
    let slug = c.slug || `cat-${c.id}`
    if (usedSlugs.has(slug)) slug = `${slug}-${c.id}`
    usedSlugs.add(slug)
    const parentId = c.parent && map.has(c.parent) ? map.get(c.parent)! : null
    const ins = await pool.query(
      `INSERT INTO categories (name_uk, name_ru, slug, parent_id, is_visible, sort_order)
       VALUES ($1, $1, $2, $3, true, 0) RETURNING id`,
      [stripHtml(c.name), slug, parentId],
    )
    map.set(c.id, ins.rows[0].id)
    slugToId.set(slug, ins.rows[0].id)
    created++
  }
  return { ok: true, op: 'categories', total: cats.length, created }
}

type WcProduct = {
  id: number
  name: string
  slug: string
  description: string
  short_description: string
  sku: string
  is_in_stock: boolean
  prices: { price: string; regular_price: string; sale_price: string }
  images: { src: string }[]
  categories: { id: number; slug: string }[]
  variations?: { id: number; attributes: { name: string; value: string }[] }[]
}

async function wcSlugToCategoryId(): Promise<Map<string, number>> {
  const res = await fetch(`${WC}/products/categories?per_page=100`)
  const cats = (await res.json()) as WcCat[]
  const bySlug = new Map(cats.map((c) => [c.slug, c.id] as [string, number]))
  const rows = await pool.query(`SELECT id, slug FROM categories`)
  const map = new Map<string, number>()
  for (const r of rows.rows) map.set(r.slug, r.id)
  // return engine id keyed by WC category id
  const out = new Map<number, number>()
  for (const [slug, wcId] of bySlug) {
    if (map.has(slug)) out.set(wcId, map.get(slug)!)
  }
  return out
}

async function opProducts(page: number, per: number) {
  const res = await fetch(`${WC}/products?per_page=${per}&page=${page}`)
  if (!res.ok) throw new Error(`wc products http ${res.status}`)
  const items = (await res.json()) as WcProduct[]
  const catMap = await wcSlugToCategoryId()
  const rows = await pool.query(`SELECT id, slug FROM products`)
  const slugToId = new Map<string, number>()
  const usedSlugs = new Set<string>()
  for (const r of rows.rows) {
    slugToId.set(r.slug, r.id)
    usedSlugs.add(r.slug)
  }
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN
  if (!blobToken) throw new Error('BLOB_READ_WRITE_TOKEN missing')

  let inserted = 0
  let skipped = 0
  const errors: { id: number; error: string }[] = []

  for (const p of items) {
    try {
      // 1) images -> Blob
      const urls: string[] = []
      for (let i = 0; i < (p.images ?? []).length; i++) {
        const src = p.images[i].src
        const img = await fetch(src)
        if (!img.ok) continue
        const buf = await img.arrayBuffer()
        const blob = await put(blobName(p.id, i, src), Buffer.from(buf), {
          access: 'public',
          token: blobToken,
          contentType: img.headers.get('content-type') ?? 'image/jpeg',
          addRandomSuffix: false,
        })
        urls.push(blob.url)
      }
      const image = urls[0] ?? null

      // 2) sizes from variations
      const sizes: string[] = []
      for (const v of p.variations ?? []) {
        for (const a of v.attributes ?? []) {
          if (/розмір/i.test(a.name) && a.value && !sizes.includes(a.value)) sizes.push(a.value)
        }
      }

      // 3) prices (minor units -> UAH)
      const priceMinor = parseInt(p.prices?.price ?? '0', 10) || 0
      const regMinor = parseInt(p.prices?.regular_price ?? '0', 10) || 0
      const price = (priceMinor / 100).toFixed(2)
      const oldPrice = regMinor > priceMinor ? (regMinor / 100).toFixed(2) : null

      // 4) slug (unique)
      let slug = p.slug || `product-${p.id}`
      if (slugToId.has(slug)) {
        const existingId = slugToId.get(slug)!
        const chk = await pool.query(`SELECT prom_id FROM products WHERE id = $1`, [existingId])
        if (chk.rows[0]?.prom_id === p.id) {
          skipped++
          continue
        }
        slug = `${slug}-${p.id}`
      }
      usedSlugs.add(slug)

      const sku = (p.sku || '').trim() || `medok-${p.id}`
      const ins = await pool.query(
        `INSERT INTO products
          (name_uk, name_ru, slug, description_uk, meta_description_uk,
           sku, prom_id, price, old_price, currency,
           quantity, unit, stock_status, is_in_stock, is_visible,
           image, images, sizes, variants_enabled)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,'UAH',$9,'шт','В наявності',$10,true,$11,$12::jsonb,$13::jsonb,false)
         RETURNING id`,
        [
          stripHtml(p.name),
          slug,
          p.description ?? '',
          stripHtml(p.short_description).slice(0, 500) || null,
          sku,
          p.id,
          price,
          oldPrice,
          p.is_in_stock ? 100 : 0,
          p.is_in_stock,
          image,
          JSON.stringify(urls),
          JSON.stringify(sizes),
        ],
      )
      const newId = ins.rows[0].id
      slugToId.set(slug, newId)

      // 5) category links
      await pool.query(`DELETE FROM product_category WHERE product_id = $1`, [newId])
      for (const c of p.categories ?? []) {
        const engineCatId = catMap.get(c.id)
        if (engineCatId) {
          await pool.query(`INSERT INTO product_category (product_id, category_id) VALUES ($1,$2)`, [
            newId,
            engineCatId,
          ])
        }
      }
      inserted++
    } catch (e) {
      errors.push({ id: p.id, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { ok: true, op: 'products', page, per, fetched: items.length, inserted, skipped, errors }
}

async function opCount() {
  const [p, c, pc] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c FROM products`),
    pool.query(`SELECT COUNT(*)::int AS c FROM categories`),
    pool.query(`SELECT COUNT(*)::int AS c FROM product_category`),
  ])
  return {
    ok: true,
    op: 'count',
    products: p.rows[0].c,
    categories: c.rows[0].c,
    product_category: pc.rows[0].c,
  }
}

export async function GET(req: NextRequest) {
  try {
    if (req.nextUrl.searchParams.get('key') !== KEY) {
      return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })
    }
    const op = req.nextUrl.searchParams.get('op') ?? 'count'
    const page = parseInt(req.nextUrl.searchParams.get('page') ?? '1', 10) || 1
    const per = Math.min(parseInt(req.nextUrl.searchParams.get('per') ?? '20', 10) || 20, 30)
    let result: unknown
    if (op === 'schema') result = await opSchema()
    else if (op === 'categories') result = await opCategories()
    else if (op === 'products') result = await opProducts(page, per)
    else result = await opCount()
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
