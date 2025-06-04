const request = require('supertest');
const jwt = require('jsonwebtoken');
process.env.NODE_ENV = 'test';
process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'testsecret';

const { app, sequelize, User, Plan } = require('../server');

let token;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  const user = await User.create({
    email: 'test@office.kopo.ac.kr',
    passwordHash: 'dummy',
    verified: true
  });
  token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
});

afterAll(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Plan.destroy({ where: {} });
});

describe('Plan API', () => {
  test('create plan', async () => {
    const res = await request(app)
      .post('/api/plans')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'plan1',
        description: 'd',
        start_time: new Date().toISOString(),
        end_time: new Date(Date.now() + 3600000).toISOString(),
        color: '#fff'
      });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('plan1');
  });

  test('get plans', async () => {
    await Plan.create({
      user_id: 1,
      title: 'p',
      start_time: new Date(),
      end_time: new Date(Date.now() + 1000)
    });
    const res = await request(app)
      .get('/api/plans')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
  });

  test('update plan', async () => {
    const plan = await Plan.create({
      user_id: 1,
      title: 'p',
      start_time: new Date(),
      end_time: new Date(Date.now() + 1000)
    });
    const res = await request(app)
      .put(`/api/plans/${plan.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'upd', start_time: new Date(), end_time: new Date(Date.now() + 1000) });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('upd');
  });

  test('delete plan', async () => {
    const plan = await Plan.create({
      user_id: 1,
      title: 'p',
      start_time: new Date(),
      end_time: new Date(Date.now() + 1000)
    });
    const res = await request(app)
      .delete(`/api/plans/${plan.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(await Plan.count()).toBe(0);
  });

  test('delete all plans', async () => {
    await Plan.bulkCreate([
      { user_id: 1, title: 'a', start_time: new Date(), end_time: new Date(Date.now() + 1000) },
      { user_id: 1, title: 'b', start_time: new Date(), end_time: new Date(Date.now() + 2000) }
    ]);
    const res = await request(app)
      .delete('/api/plans')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(await Plan.count()).toBe(0);
  });
});
