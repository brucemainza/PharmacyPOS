import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAnyPerm } from '../auth.js';

const router = Router();

// Therapeutic categories a real pharmacy organizes its shelves by — these drive the till's
// quick-select category chips directly (server/routes/categories.js just lists whatever's here).
const DEMO_CATEGORIES = [
  'Pain Relievers (Analgesics)',
  'Antibiotics',
  'Antivirals',
  'Antifungals',
  'Antihistamines',
  'Cold & Cough',
  'Gastrointestinal',
  'Cardiovascular',
  'Diabetes',
  'Respiratory',
  'Neurological & Psychiatric',
  'Hormonal',
  'Dermatological',
  'Eye & Ear',
  'Vitamins & Supplements',
  'Immunological',
  'Anticoagulants & Antiplatelets',
  'Oncology',
];

const DEMO_SUPPLIERS = ['MedSupply Ltd', 'PharmaDirect Wholesalers'];

// A deliberately varied pharmacy catalog across every therapeutic category above: brand/generic
// pairs sharing a generic_group (so the substitution flow in docs/use-cases/uc-dispensing-prescription.puml
// has something to substitute), a spread of reorder levels (so Analytics' reorder-suggestions tab
// isn't empty), several controlled substances spread across their real therapeutic categories
// rather than lumped into one (so the controlled-dispensing workflow has real products to
// exercise), and one product seeded at zero stock on purpose — proving the till/catalog/
// dispensing UIs show "out of stock"/"insufficient stock" cleanly rather than breaking when a
// medicine has run out. Names are generic (INN) or well-known OTC brands, not real prescription
// records — purely for demoing the system.
const DEMO_PRODUCTS = [
  // Pain Relievers (Analgesics)
  { name: 'Panadol 500mg Tablets', price: 12.5, category: 'Pain Relievers (Analgesics)', quantity: 150, genericGroup: 'Paracetamol', reorderLevel: 30, supplier: 'MedSupply Ltd', unitCost: 7.5 },
  { name: 'Paracetamol 500mg Tablets (Generic)', price: 6.0, category: 'Pain Relievers (Analgesics)', quantity: 200, genericGroup: 'Paracetamol', reorderLevel: 40, supplier: 'PharmaDirect Wholesalers', unitCost: 3.2 },
  { name: 'Brufen 400mg Tablets', price: 18.0, category: 'Pain Relievers (Analgesics)', quantity: 90, genericGroup: 'Ibuprofen', reorderLevel: 20, supplier: 'MedSupply Ltd', unitCost: 11.0 },
  { name: 'Ibuprofen 400mg Tablets (Generic)', price: 9.5, category: 'Pain Relievers (Analgesics)', quantity: 120, genericGroup: 'Ibuprofen', reorderLevel: 25, supplier: 'PharmaDirect Wholesalers', unitCost: 5.0 },
  { name: 'Tramadol 50mg Capsules', price: 40.0, category: 'Pain Relievers (Analgesics)', quantity: 30, reorderLevel: 10, supplier: 'MedSupply Ltd', controlledSubstance: true, unitCost: 25.0 },
  { name: 'Morphine Sulfate 10mg Injection', price: 120.0, category: 'Pain Relievers (Analgesics)', quantity: 15, reorderLevel: 5, supplier: 'MedSupply Ltd', controlledSubstance: true, unitCost: 78.0 },

  // Antibiotics
  { name: 'Amoxicillin 500mg Capsules', price: 35.0, category: 'Antibiotics', quantity: 80, genericGroup: 'Amoxicillin', reorderLevel: 20, supplier: 'MedSupply Ltd', unitCost: 22.0 },
  { name: 'Amoxicillin 250mg Suspension', price: 28.0, category: 'Antibiotics', quantity: 0, genericGroup: 'Amoxicillin', reorderLevel: 15, supplier: 'MedSupply Ltd' },
  { name: 'Augmentin 625mg Tablets', price: 65.0, category: 'Antibiotics', quantity: 40, reorderLevel: 10, supplier: 'PharmaDirect Wholesalers', unitCost: 42.0 },
  { name: 'Azithromycin 250mg Tablets', price: 38.0, category: 'Antibiotics', quantity: 55, reorderLevel: 15, supplier: 'PharmaDirect Wholesalers' },
  { name: 'Ciprofloxacin 500mg Tablets', price: 45.0, category: 'Antibiotics', quantity: 50, reorderLevel: 15, supplier: 'MedSupply Ltd' },

  // Antivirals
  { name: 'Acyclovir 400mg Tablets', price: 42.0, category: 'Antivirals', quantity: 35, reorderLevel: 10, supplier: 'MedSupply Ltd' },
  { name: 'Oseltamivir 75mg Capsules', price: 85.0, category: 'Antivirals', quantity: 20, reorderLevel: 8, supplier: 'PharmaDirect Wholesalers' },

  // Antifungals
  { name: 'Fluconazole 150mg Capsules', price: 22.0, category: 'Antifungals', quantity: 45, reorderLevel: 10, supplier: 'MedSupply Ltd' },
  { name: 'Clotrimazole Cream 1% 20g', price: 16.0, category: 'Antifungals', quantity: 60, reorderLevel: 15, supplier: 'PharmaDirect Wholesalers' },

  // Antihistamines
  { name: 'Piriton 4mg Tablets', price: 15.0, category: 'Antihistamines', quantity: 100, genericGroup: 'Chlorphenamine', reorderLevel: 20, supplier: 'PharmaDirect Wholesalers' },
  { name: 'Cetirizine 10mg Tablets', price: 20.0, category: 'Antihistamines', quantity: 85, reorderLevel: 15, supplier: 'MedSupply Ltd' },
  { name: 'Loratadine 10mg Tablets', price: 24.0, category: 'Antihistamines', quantity: 65, reorderLevel: 15, supplier: 'PharmaDirect Wholesalers' },

  // Cold & Cough
  { name: 'Benylin Cough Syrup 100ml', price: 55.0, category: 'Cold & Cough', quantity: 60, reorderLevel: 15, supplier: 'PharmaDirect Wholesalers' },
  { name: 'Codeine Linctus 100ml', price: 48.0, category: 'Cold & Cough', quantity: 25, reorderLevel: 10, supplier: 'MedSupply Ltd', controlledSubstance: true, unitCost: 29.0 },
  { name: 'Flu Relief Tablets', price: 22.0, category: 'Cold & Cough', quantity: 70, reorderLevel: 15, supplier: 'PharmaDirect Wholesalers' },

  // Gastrointestinal
  { name: 'Omeprazole 20mg Capsules', price: 32.0, category: 'Gastrointestinal', quantity: 55, reorderLevel: 15, supplier: 'MedSupply Ltd' },
  { name: 'Buscopan 10mg Tablets', price: 40.0, category: 'Gastrointestinal', quantity: 45, reorderLevel: 10, supplier: 'PharmaDirect Wholesalers' },
  { name: 'ORS Rehydration Sachets', price: 8.0, category: 'Gastrointestinal', quantity: 150, reorderLevel: 30, supplier: 'MedSupply Ltd' },
  { name: 'Loperamide 2mg Capsules', price: 18.0, category: 'Gastrointestinal', quantity: 50, reorderLevel: 15, supplier: 'PharmaDirect Wholesalers' },

  // Cardiovascular
  { name: 'Amlodipine 5mg Tablets', price: 28.0, category: 'Cardiovascular', quantity: 70, reorderLevel: 15, supplier: 'MedSupply Ltd' },
  { name: 'Atorvastatin 20mg Tablets', price: 34.0, category: 'Cardiovascular', quantity: 60, reorderLevel: 15, supplier: 'PharmaDirect Wholesalers' },
  { name: 'Losartan 50mg Tablets', price: 30.0, category: 'Cardiovascular', quantity: 55, reorderLevel: 15, supplier: 'MedSupply Ltd' },

  // Diabetes
  { name: 'Metformin 500mg Tablets', price: 20.0, category: 'Diabetes', quantity: 90, reorderLevel: 20, supplier: 'PharmaDirect Wholesalers' },
  { name: 'Glibenclamide 5mg Tablets', price: 18.0, category: 'Diabetes', quantity: 40, reorderLevel: 10, supplier: 'MedSupply Ltd' },
  { name: 'Insulin Mixtard 30/70 Vial', price: 95.0, category: 'Diabetes', quantity: 18, reorderLevel: 8, supplier: 'PharmaDirect Wholesalers', unitCost: 60.0 },

  // Respiratory
  { name: 'Salbutamol Inhaler 100mcg', price: 45.0, category: 'Respiratory', quantity: 35, reorderLevel: 10, supplier: 'MedSupply Ltd' },
  { name: 'Beclomethasone Inhaler 250mcg', price: 60.0, category: 'Respiratory', quantity: 25, reorderLevel: 8, supplier: 'PharmaDirect Wholesalers' },

  // Neurological & Psychiatric
  { name: 'Sertraline 50mg Tablets', price: 38.0, category: 'Neurological & Psychiatric', quantity: 40, reorderLevel: 10, supplier: 'MedSupply Ltd' },
  { name: 'Diazepam 5mg Tablets', price: 30.0, category: 'Neurological & Psychiatric', quantity: 20, reorderLevel: 5, supplier: 'PharmaDirect Wholesalers', controlledSubstance: true, unitCost: 18.0 },
  { name: 'Sodium Valproate 200mg Tablets', price: 36.0, category: 'Neurological & Psychiatric', quantity: 30, reorderLevel: 10, supplier: 'MedSupply Ltd' },

  // Hormonal
  { name: 'Levothyroxine 50mcg Tablets', price: 25.0, category: 'Hormonal', quantity: 50, reorderLevel: 15, supplier: 'PharmaDirect Wholesalers' },
  { name: 'Prednisolone 5mg Tablets', price: 20.0, category: 'Hormonal', quantity: 45, reorderLevel: 10, supplier: 'MedSupply Ltd' },
  { name: 'Combined Oral Contraceptive Pill', price: 32.0, category: 'Hormonal', quantity: 60, reorderLevel: 15, supplier: 'PharmaDirect Wholesalers' },

  // Dermatological
  { name: 'Hydrocortisone Cream 1% 15g', price: 14.0, category: 'Dermatological', quantity: 55, reorderLevel: 15, supplier: 'MedSupply Ltd' },
  { name: 'Betamethasone Cream 0.1% 15g', price: 19.0, category: 'Dermatological', quantity: 40, reorderLevel: 10, supplier: 'PharmaDirect Wholesalers' },
  { name: 'Benzoyl Peroxide Gel 5%', price: 22.0, category: 'Dermatological', quantity: 35, reorderLevel: 10, supplier: 'MedSupply Ltd' },

  // Eye & Ear
  { name: 'Chloramphenicol Eye Drops 0.5%', price: 16.0, category: 'Eye & Ear', quantity: 50, reorderLevel: 15, supplier: 'PharmaDirect Wholesalers' },
  { name: 'Sodium Cromoglicate Eye Drops', price: 24.0, category: 'Eye & Ear', quantity: 30, reorderLevel: 10, supplier: 'MedSupply Ltd' },

  // Vitamins & Supplements
  { name: 'Vitamin C 1000mg Tablets', price: 25.0, category: 'Vitamins & Supplements', quantity: 100, reorderLevel: 20, supplier: 'PharmaDirect Wholesalers' },
  { name: 'Ferrous Sulphate Tablets', price: 18.0, category: 'Vitamins & Supplements', quantity: 70, reorderLevel: 15, supplier: 'PharmaDirect Wholesalers' },
  { name: 'Vitamin D3 1000IU Tablets', price: 28.0, category: 'Vitamins & Supplements', quantity: 65, reorderLevel: 15, supplier: 'MedSupply Ltd' },
  { name: 'Calcium Carbonate 500mg Tablets', price: 20.0, category: 'Vitamins & Supplements', quantity: 60, reorderLevel: 15, supplier: 'MedSupply Ltd' },

  // Immunological
  { name: 'Tetanus Toxoid Vaccine', price: 30.0, category: 'Immunological', quantity: 25, reorderLevel: 10, supplier: 'PharmaDirect Wholesalers' },
  { name: 'Hepatitis B Vaccine', price: 55.0, category: 'Immunological', quantity: 20, reorderLevel: 8, supplier: 'MedSupply Ltd' },

  // Anticoagulants & Antiplatelets
  { name: 'Aspirin 75mg Tablets (Low-Dose)', price: 10.0, category: 'Anticoagulants & Antiplatelets', quantity: 90, reorderLevel: 20, supplier: 'PharmaDirect Wholesalers' },
  { name: 'Warfarin 5mg Tablets', price: 26.0, category: 'Anticoagulants & Antiplatelets', quantity: 35, reorderLevel: 10, supplier: 'MedSupply Ltd' },
  { name: 'Clopidogrel 75mg Tablets', price: 40.0, category: 'Anticoagulants & Antiplatelets', quantity: 30, reorderLevel: 10, supplier: 'PharmaDirect Wholesalers' },

  // Oncology
  { name: 'Tamoxifen 20mg Tablets', price: 65.0, category: 'Oncology', quantity: 15, reorderLevel: 5, supplier: 'MedSupply Ltd', unitCost: 45.0 },
  { name: 'Methotrexate 2.5mg Tablets', price: 58.0, category: 'Oncology', quantity: 12, reorderLevel: 5, supplier: 'PharmaDirect Wholesalers', unitCost: 40.0 },
];

const DEMO_CUSTOMERS = [
  { name: 'Thabo Molefe', phone: '082 555 0101', email: 'thabo@example.com', address: 'Sandton', dateOfBirth: '1985-03-14', allergies: 'Penicillin' },
  { name: 'Aisha Khan', phone: '083 555 0202', email: 'aisha@example.com', address: 'Cape Town', dateOfBirth: '1990-07-22', allergies: '' },
  { name: 'Johan van Wyk', phone: '084 555 0303', email: 'johan@example.com', address: 'Pretoria', dateOfBirth: '1978-11-05', allergies: 'Sulfa drugs' },
];

function daysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

router.post('/seed', requireAnyPerm('perm_products', 'perm_settings'), (_req, res) => {
  const db = getDb();

  const result = db.transaction(() => {
    let categoriesAdded = 0;
    let productsAdded = 0;
    let customersAdded = 0;
    let suppliersAdded = 0;
    let batchesAdded = 0;

    for (const name of DEMO_CATEGORIES) {
      const existing = db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
      if (!existing) {
        db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
        categoriesAdded += 1;
      }
    }

    const supplierIds = {};
    for (const name of DEMO_SUPPLIERS) {
      let row = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(name);
      if (!row) {
        const result2 = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(name);
        row = { id: result2.lastInsertRowid };
        suppliersAdded += 1;
      }
      supplierIds[name] = row.id;
    }

    const insertProduct = db.prepare(
      `INSERT INTO products
        (name, price, category, quantity, stock, img, controlled_substance, generic_group,
         reorder_level, supplier_id, batch_tracked)
       VALUES (?, ?, ?, ?, 1, '', ?, ?, ?, ?, ?)`
    );
    const insertBatch = db.prepare(
      `INSERT INTO product_batches (product_id, batch_no, expiry_date, qty_on_hand, unit_cost, supplier_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    let batchSeq = 0;
    const now = new Date().toISOString();
    for (const p of DEMO_PRODUCTS) {
      const existing = db.prepare('SELECT id FROM products WHERE name = ?').get(p.name);
      if (existing) continue;

      const supplierId = p.supplier ? supplierIds[p.supplier] : null;
      const hasCost = typeof p.unitCost === 'number';
      const result2 = insertProduct.run(
        p.name,
        p.price,
        p.category,
        p.quantity,
        p.controlledSubstance ? 1 : 0,
        p.genericGroup || '',
        p.reorderLevel || 0,
        supplierId,
        hasCost ? 1 : 0
      );
      productsAdded += 1;

      // Enrichment only, not a real GRN: gives batch-tracked products expiry dates and a landed
      // cost so the Inventory expiry-alerts view and Analytics profit/margin & stock-valuation
      // reports have real demo data, without needing a matching stock_movements ledger entry
      // (seed data isn't a real receiving event). A couple of batches are deliberately
      // near-expiry or already expired to demonstrate those alerts out of the box.
      if (hasCost && p.quantity > 0) {
        batchSeq += 1;
        const expiryDate =
          batchSeq % 5 === 0 ? daysFromNow(-10) : batchSeq % 4 === 0 ? daysFromNow(20) : daysFromNow(365);
        insertBatch.run(
          result2.lastInsertRowid,
          `DEMO-${String(batchSeq).padStart(3, '0')}`,
          expiryDate,
          p.quantity,
          p.unitCost,
          supplierId,
          now
        );
        batchesAdded += 1;
      }
    }

    const insertCustomer = db.prepare(
      `INSERT INTO customers (name, phone, email, address, date_of_birth, allergies)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const c of DEMO_CUSTOMERS) {
      const existing = db.prepare('SELECT id FROM customers WHERE name = ?').get(c.name);
      if (!existing) {
        insertCustomer.run(c.name, c.phone, c.email, c.address, c.dateOfBirth, c.allergies);
        customersAdded += 1;
      }
    }

    return { categoriesAdded, productsAdded, customersAdded, suppliersAdded, batchesAdded };
  })();

  res.json({
    ok: true,
    ...result,
    message: `Added ${result.productsAdded} products, ${result.categoriesAdded} categories, ${result.suppliersAdded} suppliers, ${result.batchesAdded} batches, ${result.customersAdded} patients`,
  });
});

router.post('/clear', requireAnyPerm('perm_products', 'perm_settings'), (req, res) => {
  const body = req.body || {};
  const clearProducts = body.products !== false;
  const clearCategories = body.categories !== false;
  const clearCustomers = body.customers !== false;
  const clearTransactions = body.transactions !== false;

  const db = getDb();
  const counts = db.transaction(() => {
    const out = {
      products: 0,
      categories: 0,
      customers: 0,
      transactions: 0,
    };

    if (clearTransactions) {
      const r = db.prepare('DELETE FROM transactions').run();
      out.transactions = r.changes || 0;
    }
    if (clearProducts) {
      db.prepare('DELETE FROM product_batches').run();
      const r = db.prepare('DELETE FROM products').run();
      out.products = r.changes || 0;
    }
    if (clearCategories) {
      const r = db.prepare('DELETE FROM categories').run();
      out.categories = r.changes || 0;
    }
    if (clearCustomers) {
      const r = db
        .prepare("DELETE FROM customers WHERE name != 'Walk-in Customer'")
        .run();
      out.customers = r.changes || 0;
    }

    return out;
  })();

  // sql.js wrapper may not expose changes reliably — recount deleted via before if needed
  res.json({
    ok: true,
    deleted: counts,
    message: 'Catalog and related demo data cleared',
  });
});

export default router;
