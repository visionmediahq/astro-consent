import { writeFileSync } from 'node:fs'
import { generateServicesJson } from '../src/services'

const target = new URL('../services.json', import.meta.url)
writeFileSync(target, JSON.stringify(generateServicesJson(), null, 2) + '\n')
console.log('✓ wrote services.json')
