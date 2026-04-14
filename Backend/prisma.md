npm prisma init ( i guess )

npm install prisma@5 @prisma/client@5

npx prisma migrate dev --name init

npx prisma generate     // for prisma client

// only if all tables i should reconstruct 

npx prisma migrate reset
then create new migration file then seed if needed since all the data would be lost

// seeding

SEED_ENABLED=true npx prisma db seed

// see database

npx prisma studio