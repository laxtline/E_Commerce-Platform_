/** Isolated audit fixture: never connects to the configured application database. */
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

async function main() {
  const mem = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    MONGODB_URI: mem.getUri(), JWT_SECRET: 'isolated-audit-only', GOOGLE_CLIENT_ID: 'audit-client',
    NODE_ENV: 'test', RAZORPAY_KEY_ID: 'audit-key', RAZORPAY_KEY_SECRET: 'audit-secret',
    RAZORPAY_WEBHOOK_SECRET: 'audit-webhook-secret', REFUND_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    RESEND_API_KEY: '', EMAIL_FROM: '', EXPO_PUSH_ENABLED: 'false',
  });
  const { connectDB, disconnectDB } = await import('../config/db.js');
  const { createApp } = await import('../app.js');
  const { UserModel } = await import('../models/User.js');
  const { ProductModel } = await import('../models/Product.js');
  const { CategoryModel } = await import('../models/Category.js');
  const { OrderModel } = await import('../models/Order.js');
  const { CartModel } = await import('../models/Cart.js');
  const { signToken } = await import('../utils/jwt.js');
  await connectDB();
  const admin = await UserModel.create({googleId:'audit-admin',email:'suryakant321pradhan@gmail.com',name:'Audit Admin'});
  const user = await UserModel.create({googleId:'audit-user',email:'customer@example.test',name:'Audit Customer'});
  const other = await UserModel.create({googleId:'audit-other',email:'other@example.test',name:'Other Customer'});
  const cat = await CategoryModel.create({name:'Audit Tiles',order:1});
  const product = await ProductModel.create({title:'Audit Tile',category:cat._id,sku:'AUDIT-1',price:48,mrp:65,stock:100,images:[],bulkPricing:[{minQty:10,pricePerUnit:42}]});
  const app = createApp();
  const server = app.listen(process.argv.includes('--serve') ? 5000 : 0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening',resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const results: {name:string;pass:boolean;detail:unknown}[]=[];
  const check=(name:string,pass:boolean,detail:unknown='')=>{results.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name} ${JSON.stringify(detail)}`);};
  const api=async (route:string,method='GET',body?:unknown,who:any=user,extra:Record<string,string>={})=>{
    const response=await fetch(`${base}${route}`,{method,headers:{'Content-Type':'application/json',...(who?{Cookie:`rt_token=${signToken({userId:String(who._id)})}`} : {}),...extra},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
    const json:any=await response.json().catch(()=>null);return {status:response.status,data:json?.data,message:json?.message,json};
  };
  const address={fullName:'Audit Customer',phone:'9876543210',line1:'1 Test Street',city:'Cuttack',state:'Odisha',pincode:'753001'};
  try {
    check('public catalog', (await api('/api/products','GET',undefined,null)).data?.items?.length===1);
    check('unauthenticated cart rejected',(await api('/api/cart','GET',undefined,null)).status===401);
    check('customer admin access rejected',(await api('/api/orders/admin/all')).status===403);
    check('invalid Google token rejected',(await api('/api/auth/google','POST',{credential:'invalid'},null)).status===401);
    check('session restores correct customer',(await api('/api/auth/me')).data?.user?.email===user.email);
    check('add cart',(await api('/api/cart/add','POST',{productId:String(product._id),quantity:12})).status===201);
    check('cart persisted in database',(await CartModel.findOne({user:user._id}))?.items[0]?.quantity===12);
    check('oversized quantity rejected',(await api('/api/cart/update','PUT',{productId:String(product._id),quantity:101})).status===400);
    check('wishlist add',(await api('/api/wishlist/add','POST',{productId:String(product._id)})).status===201);
    check('wishlist reload persists',(await api('/api/wishlist')).data?.items?.length===1);
    check('wishlist remove',(await api(`/api/wishlist/remove/${product._id}`,'DELETE')).status===200);
    const saved=await api('/api/addresses','POST',address);
    check('saved address persists',(await UserModel.findById(user._id))?.addresses.length===1,saved.status);
    const coupon=await api('/api/coupons','POST',{code:'AUDIT10',type:'PERCENT',value:10,minOrder:100},admin);
    check('admin coupon create',coupon.status===201,coupon.message);
    const validation=await api('/api/coupons/validate','POST',{code:'AUDIT10',itemsTotal:1});
    check('coupon uses server cart instead of client total',validation.data?.discount===50.4,validation.data);
    const placed=await api('/api/orders','POST',{shippingAddress:address,couponCode:'AUDIT10'});
    check('COD order commits with server pricing',placed.status===201&&placed.data?.total===502.6,{status:placed.status,total:placed.data?.total,message:placed.message});
    if (!placed.data?.id) throw new Error('Cannot proceed without isolated order');
    const id=placed.data.id;
    check('order saved to database',!!await OrderModel.findById(id));
    check('stock deducted once',(await ProductModel.findById(product._id))?.stock===88);
    check('cart clears after commit',(await CartModel.findOne({user:user._id}))?.items.length===0);
    check('other customer cannot read order',(await api(`/api/orders/${id}`,'GET',undefined,other)).status===403);
    check('invalid order jump rejected',(await api(`/api/orders/${id}/status`,'PATCH',{status:'DELIVERED'},admin)).status===400);
    for (const status of ['CONFIRMED','PACKED','SHIPPED','OUT_FOR_DELIVERY','DELIVERED']) {
      const next=await api(`/api/orders/${id}/status`,'PATCH',{status},admin);
      check(`order transition ${status}`,next.status===200&&next.data?.status===status,next.message);
    }
    check('delivered COD has a recorded payment',(await OrderModel.findById(id))?.paymentStatus==='PAID',{paymentStatus:(await OrderModel.findById(id))?.paymentStatus,note:'Currently deliberately PENDING; no collection API/UI exists.'});
    const courier=await api(`/api/orders/${id}/courier`,'PUT',{courierName:'DTDC',trackingId:'AUDIT123'},admin);
    check('courier update succeeds',courier.status===200,courier.message);
    const tracked=await api(`/api/orders/${id}/track`);
    check('courier history contains real order status',tracked.data?.statusHistory?.every((x:any)=>x.status!=='$status'),tracked.data?.statusHistory?.at(-1));
    check('tracking returns saved courier',tracked.data?.courier?.trackingId==='AUDIT123');
    const review=await api('/api/reviews','POST',{productId:String(product._id),rating:4,comment:'Audit review'});
    check('review saves and rating updates',review.status===201&&(await ProductModel.findById(product._id))?.rating===4);
    const ret=await api(`/api/orders/${id}/return`,'POST',{reason:'Damaged',pickupAddress:address});
    check('return request persists',ret.status===201,ret.message);
    if(ret.data?.id){
      const jumped=await api(`/api/orders/admin/returns/${ret.data.id}`,'PUT',{status:'REFUNDED'},admin);
      check('return cannot skip approval and refund payment',jumped.status===400,{status:jumped.status,stored:jumped.data?.status});
      await api(`/api/orders/admin/returns/${ret.data.id}`,'PUT',{status:'APPROVED'},admin);
      const refund=await api(`/api/orders/admin/returns/${ret.data.id}/refund`,'POST',{method:'UPI',amount:999999,upiId:'audit@upi'},admin);
      check('refund cannot exceed order amount',refund.status===400,{status:refund.status,amount:refund.data?.amount,message:refund.message});
    }
    await api('/api/cart/add','POST',{productId:String(product._id),quantity:1});
    const online=await api('/api/orders','POST',{shippingAddress:address,paymentMethod:'RAZORPAY'});
    check('online order can be reserved',online.status===201,online.message);
    if(online.data?.id){
      await OrderModel.updateOne({_id:online.data.id},{$set:{paymentStatus:'FAILED'}});
      const stats=await api('/api/orders/admin/stats','GET',undefined,admin);
      check('failed payment excluded from revenue',stats.data?.revenue===502.6,{revenue:stats.data?.revenue});
      await api(`/api/orders/${online.data.id}/cancel`,'PATCH');
      const payload=JSON.stringify({event:'payment.captured',id:'audit-event',payload:{payment:{entity:{id:'pay_audit',order_id:'order_audit',amount:9700,currency:'INR',notes:{orderId:online.data.id}}}}},null,2);
      const signature=crypto.createHmac('sha256','audit-webhook-secret').update(payload).digest('hex');
      const webhook=await api('/api/payments/razorpay/webhook','POST',payload,null,{'x-razorpay-signature':signature});
      check('webhook verifies exact signed bytes',webhook.status===200,{status:webhook.status,message:webhook.message});
      const compact=JSON.stringify(JSON.parse(payload));
      const webhook2=await api('/api/payments/razorpay/webhook','POST',compact,null,{'x-razorpay-signature':crypto.createHmac('sha256','audit-webhook-secret').update(compact).digest('hex')});
      const after=await OrderModel.findById(online.data.id);
      check('cancelled online order not marked paid by webhook',after?.paymentStatus!=='PAID',{http:webhook2.status,status:after?.status,paymentStatus:after?.paymentStatus});
      const short=await api('/api/payments/razorpay/webhook','POST',{},null,{'x-razorpay-signature':'x'});
      check('malformed webhook signature returns client error',short.status===400,{status:short.status});
    }
    const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=';
    const uploaded=await api('/api/uploads','POST',{image:png},admin);
    check('local upload writes image',uploaded.status===201,uploaded.data);
    if(uploaded.data?.url){
      check('uploaded image can be fetched',(await fetch(uploaded.data.url)).status===200);
      const setImage=await api(`/api/products/${product._id}`,'PUT',{images:[uploaded.data.url]},admin);
      check('uploaded image can be saved on product',setImage.status===200,{status:setImage.status,message:setImage.message});
      fs.unlinkSync(path.join(process.cwd(),'uploads',path.basename(new URL(uploaded.data.url).pathname)));
    }
    const merge=await api('/api/cart/merge','POST',{items:[{productId:String(product._id),quantity:2}]});
    check('mobile cart merge persists',merge.status===200&&(await CartModel.findOne({user:user._id}))?.items[0]?.quantity===2,merge.message);
    const merge2=await api('/api/cart/merge','POST',{items:[{productId:String(product._id),quantity:2}]});
    check('mobile merge retry idempotent',merge2.data?.items?.[0]?.quantity===2);
    check('cart update persists',(await api('/api/cart/update','PUT',{productId:String(product._id),quantity:3})).data?.items?.[0]?.quantity===3);
    check('cart remove persists',(await api(`/api/cart/remove/${product._id}`,'DELETE')).data?.items?.length===0);
    const addressId=saved.data?.addresses?.[0]?.id;
    check('address update persists',(await api(`/api/addresses/${addressId}`,'PUT',{...address,city:'Bhubaneswar'})).data?.addresses?.[0]?.city==='Bhubaneswar');
    check('address delete persists',(await api(`/api/addresses/${addressId}`,'DELETE')).data?.addresses?.length===0);
    check('brand update persists',(await api('/api/brand','PUT',{appName:'Audit Shop'},admin)).status===200&&(await api('/api/brand')).data?.appName==='Audit Shop');
    const extraCat=await api('/api/categories','POST',{name:'Disposable Category'},admin);
    check('category create',extraCat.status===201);
    const disposable=await api('/api/products','POST',{title:'Disposable Product',sku:'AUDIT-2',category:extraCat.data?.id,price:100,mrp:120,stock:5},admin);
    check('product create',disposable.status===201,disposable.message);
    check('product update persists',(await api(`/api/products/${disposable.data?.id}`,'PUT',{price:90},admin)).data?.price===90);
    check('search finds matching product',(await api('/api/search?q=Disposable','GET',undefined,null)).data?.items?.some((p:any)=>p.id===disposable.data?.id));
    const page=await api('/api/products?limit=1','GET',undefined,null);
    const next=await api(`/api/products?limit=1&cursor=${encodeURIComponent(page.data?.nextCursor??'')}`,'GET',undefined,null);
    check('catalog cursor returns distinct second page',!!page.data?.nextCursor&&page.data?.items?.[0]?.id!==next.data?.items?.[0]?.id);
    check('product delete',(await api(`/api/products/${disposable.data?.id}`,'DELETE',undefined,admin)).status===200);
    check('deleted product hidden publicly',(await api(`/api/products/${disposable.data?.slug}`,'GET',undefined,null)).status===404);
    check('coupon update',(await api(`/api/coupons/${coupon.data?.id}`,'PUT',{description:'Updated audit'},admin)).status===200);
    check('coupon usage recorded',(await api(`/api/coupons/${coupon.data?.id}/usage`,'GET',undefined,admin)).status===200);
    check('review delete resets rating',(await api(`/api/reviews/${review.data?.id}`,'DELETE')).status===200&&(await ProductModel.findById(product._id))?.numReviews===0);
    await api('/api/cart/add','POST',{productId:String(product._id),quantity:1});
    const cancelled=await api('/api/orders','POST',{shippingAddress:address});
    const beforeStock=(await ProductModel.findById(product._id))!.stock;
    check('cancel restores stock',(await api(`/api/orders/${cancelled.data?.id}/cancel`,'PATCH')).status===200&&(await ProductModel.findById(product._id))?.stock===beforeStock+1);
    await api(`/api/orders/${cancelled.data?.id}/cancel`,'PATCH');
    check('repeat cancellation does not duplicate stock',(await ProductModel.findById(product._id))?.stock===beforeStock+1);
    await api('/api/cart/add','POST',{productId:String(product._id),quantity:1});
    const failed=await api('/api/orders','POST',{shippingAddress:address,paymentMethod:'RAZORPAY'});
    await OrderModel.collection.updateOne({_id:new (await import('mongoose')).Types.ObjectId(failed.data?.id)},{$set:{paymentStatus:'FAILED',createdAt:new Date(Date.now()-3*3600000)}});
    const {cleanupAbandonedOrders}=await import('../services/orderCleanup.js');
    await cleanupAbandonedOrders();
    check('cleanup releases failed online payment reservation',(await OrderModel.findById(failed.data?.id))?.status==='CANCELLED');
    check('logout endpoint succeeds',(await api('/api/auth/logout','POST')).status===200);
  } finally {
    const out=path.resolve(process.cwd(),'../../AUDIT_RESULTS.json');
    fs.writeFileSync(out,JSON.stringify({date:'2026-11-10',fixture:'Isolated single-node MongoDB replica set; synthetic auth sessions; no external payments or email',results},null,2));
    console.log(`AUDIT COMPLETE: ${results.filter(x=>x.pass).length}/${results.length} passed`);
    if(process.argv.includes('--serve')) {
      console.log('Isolated audit API stays available on 127.0.0.1:5000 for browser verification.');
      await new Promise<void>(resolve=>{process.once('SIGINT',()=>resolve());process.once('SIGTERM',()=>resolve());});
    }
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await disconnectDB();await mem.stop();
    process.exitCode=results.some(result=>!result.pass)?1:0;
  }
}
main().catch(error=>{console.error(error);process.exit(1);});
