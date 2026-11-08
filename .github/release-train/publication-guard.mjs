// Official semantic-release calls prepare after notes generation and before tag creation.
export function assertPublicationEnabled(env=process.env){
 if(env.RELEASE_ENABLED!=='true')throw Error('Publication remains disabled');
}
export function assertSealedRelease(plan,nextRelease,{notes=false}={}){
 if(plan.schema_version!==1||plan.verification!=='passed'||plan.release_needed!==true)throw Error('Publication requires the sealed verified release plan');
 if(nextRelease.gitHead!==plan.candidate_sha||nextRelease.version!==plan.version||nextRelease.gitTag!==plan.tag)throw Error('Semantic-release differs from sealed candidate/version/tag');
 if(notes&&(typeof plan.notes!=='string'||typeof nextRelease.notes!=='string'||nextRelease.notes!==plan.notes))throw Error('Release notes changed after analysis: generated notes differ from the sealed plan');
}
export function publicationGuard(plan,env=process.env){
 return {
  verifyRelease(_options,context){assertPublicationEnabled(context.env??env);assertSealedRelease(plan,context.nextRelease);},
  prepare(_options,context){assertPublicationEnabled(context.env??env);assertSealedRelease(plan,context.nextRelease,{notes:true});},
 };
}
