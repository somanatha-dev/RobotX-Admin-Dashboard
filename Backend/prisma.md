npm prisma init ( i guess )

npm install prisma@5 @prisma/client@5

npx prisma migrate dev --name init

// only if all tables i should reconstruct 

npx prisma migrate reset
then create new migration file then seed if needed since all the data would be lost

// seeding

npx prisma db seed