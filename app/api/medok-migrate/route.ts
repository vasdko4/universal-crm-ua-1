/**
 * TEMPORARY one-shot repair (Med-OK stand): the WooCommerce import stored
 * percent-encoded Cyrillic slugs, which the storefront cannot resolve
 * (product/category pages 404). This route regenerates every product and
 * category slug with the engine's OWN slugifiers — the same functions the
 * admin center uses (lib/slug.ts generateUniqueSlug semantics for products,
 * lib/text.ts slugify for categories) — then busts the storefront cache.
 * DELETE THIS ROUTE right after use.
 */
import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { db } from '@/lib/db'
import { products, categories } from '@/lib/db/schema'
import { asc, eq } from 'drizzle-orm'
import { slugify } from '@/lib/slug'
import { slugify as slugifyText } from '@/lib/text'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function keyOk(req: NextRequest): boolean {
  const key = req.nextUrl.searchParams.get('key') || ''
  const expected = process.env.MEDOK_MIGRATE_KEY || ''
  return expected.length >= 16 && key === expected
}

async function fixSlugs() {
  const prods = await db
    .select({ id: products.id, nameUk: products.nameUk, nameRu: products.nameRu, slug: products.slug })
    .from(products)
    .orderBy(asc(products.id))
  const used = new Set<string>()
  let pFixed = 0
  for (const p of prods) {
    const base = slugify(p.nameUk || p.nameRu || '') || `product-${p.id}`
    let candidate = base
    let n = 2
    while (used.has(candidate)) candidate = `${base}-${n++}`
    used.add(candidate)
    if (candidate !== p.slug) {
      await db.update(products).set({ slug: candidate }).where(eq(products.id, p.id))
      pFixed++
    }
  }
  const cats = await db
    .select({ id: categories.id, nameUk: categories.nameUk, slug: categories.slug })
    .from(categories)
    .orderBy(asc(categories.id))
  const usedC = new Set<string>()
  let cFixed = 0
  for (const c of cats) {
    const base = slugifyText(c.nameUk || '', 'category')
    let candidate = base
    let n = 2
    while (usedC.has(candidate)) candidate = `${base}-${n++}`
    usedC.add(candidate)
    if (candidate !== c.slug) {
      await db.update(categories).set({ slug: candidate }).where(eq(categories.id, c.id))
      cFixed++
    }
  }
  revalidateTag('shop:catalog', 'max')
  revalidateTag('shop:categories', 'max')
  return { productsFixed: pFixed, productsTotal: prods.length, categoriesFixed: cFixed, categoriesTotal: cats.length }
}

export async function GET(req: NextRequest) {
  if (!keyOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const op = req.nextUrl.searchParams.get('op') || ''
  try {
    if (op === 'fixslugs') return NextResponse.json({ ok: true, ...(await fixSlugs()) })
    return NextResponse.json({ error: 'unknown op' }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
