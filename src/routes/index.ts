import { Router } from 'express';
import { checkDbConnection } from '../config/db';
import { auditRouter } from '../modules/audit/audit.routes';
import { authRouter } from '../modules/auth/auth.routes';
import { businessesRouter } from '../modules/businesses/businesses.routes';
import { categoriesRouter } from '../modules/categories/categories.routes';
import { closingsRouter } from '../modules/closings/closings.routes';
import { inventoryRouter } from '../modules/inventory/inventory.routes';
import { mpesaRouter } from '../modules/payments/mpesa.routes';
import { paymentsRouter } from '../modules/payments/payments.routes';
import { productsRouter } from '../modules/products/products.routes';
import { purchasesRouter } from '../modules/purchases/purchases.routes';
import { reportsRouter } from '../modules/reports/reports.routes';
import { salesRouter } from '../modules/sales/sales.routes';
import { suppliersRouter } from '../modules/suppliers/suppliers.routes';
import { usersRouter } from '../modules/users/users.routes';

/**
 * Everything under /api. Tenant routes need `Authorization: Bearer <token>` and
 * `X-Business-Id`; /auth and /health do not.
 */
export const apiRouter = Router();

/** Liveness + DB reachability. Unauthenticated; returns no business data. */
apiRouter.get('/health', async (_req, res) => {
  try {
    await checkDbConnection();
    res.json({ status: 'ok', db: 'up' });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/businesses', businessesRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/categories', categoriesRouter);
apiRouter.use('/suppliers', suppliersRouter);
apiRouter.use('/products', productsRouter);
apiRouter.use('/inventory', inventoryRouter);
apiRouter.use('/purchases', purchasesRouter);
apiRouter.use('/sales', salesRouter);
apiRouter.use('/payments/mpesa', mpesaRouter); // before /payments so its public callback is not behind login
apiRouter.use('/payments', paymentsRouter);
apiRouter.use('/closings', closingsRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/audit', auditRouter);
